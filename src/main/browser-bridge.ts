import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Local bridge between the desktop app and the Dev Companion Chrome extension.
 *
 * - Listens on 127.0.0.1 only.
 * - Only chrome-extension:// origins are accepted (web pages cannot connect).
 * - The extension must present the pairing token shown in the app.
 * - One extension connection at a time; requests time out.
 */

export const DEFAULT_BRIDGE_PORT = 47821
const REQUEST_TIMEOUT_MS = 15_000

export type BrowserField = {
  ref: string
  label: string
  type: string
  name: string
  value: string
  sensitive: boolean
}

export type BrowserElement = { ref: string; text: string; tag: string }

export type BrowserTabContext = {
  url: string
  title: string
  headings: string[]
  text: string
  fields: BrowserField[]
  buttons: BrowserElement[]
  links: Array<{ text: string; href: string }>
  capturedAt: string
}

export type BridgeStatus = { listening: boolean; port: number; connected: boolean; extensionVersion: string | null; error: string | null }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export function createPairingToken(): string {
  return randomBytes(24).toString('base64url')
}

function tokensMatch(expected: string, given: string | null): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class BrowserBridge {
  private server: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private extensionVersion: string | null = null
  private error: string | null = null
  private keepAlive: NodeJS.Timeout | null = null

  constructor(private getToken: () => string, private port = DEFAULT_BRIDGE_PORT, private onChange: () => void = () => {}) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: this.port, maxPayload: 2 * 1024 * 1024, verifyClient: (info, done) => done(this.verify(info.req, info.origin)) })
      server.on('listening', () => { this.server = server; this.error = null; this.onChange(); resolve() })
      server.on('error', (error: NodeJS.ErrnoException) => {
        this.error = error.code === 'EADDRINUSE' ? `Port ${this.port} is already in use.` : error.message
        this.onChange()
        resolve()
      })
      server.on('connection', (socket, request) => this.attach(socket, request))
    })
  }

  private verify(request: IncomingMessage, origin: string | undefined): boolean {
    if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    return tokensMatch(this.getToken(), url.searchParams.get('token'))
  }

  private attach(socket: WebSocket, request: IncomingMessage): void {
    this.socket?.close(4000, 'replaced by a newer connection')
    this.socket = socket
    this.extensionVersion = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('v')
    this.onChange()
    // Keeps the extension's MV3 service worker alive while connected.
    this.keepAlive = setInterval(() => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ping' })) }, 20_000)
    socket.on('message', (raw) => {
      let message: { id?: string; ok?: boolean; result?: unknown; error?: string }
      try { message = JSON.parse(String(raw)) } catch { return }
      if (!message.id) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new Error(message.error ?? 'Extension error'))
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.extensionVersion = null
        if (this.keepAlive) clearInterval(this.keepAlive)
        for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error('Extension disconnected.')); this.pending.delete(id) }
        this.onChange()
      }
    })
  }

  status(): BridgeStatus {
    return { listening: Boolean(this.server), port: this.port, connected: Boolean(this.socket), extensionVersion: this.extensionVersion, error: this.error }
  }

  /** Disconnect the current extension (used after the pairing token is rotated). */
  disconnect(): void {
    this.socket?.close(4001, 'token rotated')
  }

  request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.reject(new Error('Chrome extension is not connected. Install it from apps/browser-extension and paste the pairing token.'))
    }
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser did not respond in time.')) }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ id, type, ...payload }))
    })
  }

  async close(): Promise<void> {
    this.socket?.close()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
  }
}

/** Compact text form of a tab for the model. Sensitive field values are never included. */
export function describeTab(tab: BrowserTabContext, maxText = 6_000): string {
  const lines = [`URL: ${tab.url}`, `Title: ${tab.title}`]
  if (tab.headings.length) lines.push(`Headings: ${tab.headings.slice(0, 15).join(' | ')}`)
  if (tab.fields.length) {
    lines.push('Form fields (ref · label · type · current value):')
    for (const field of tab.fields.slice(0, 60)) {
      const value = field.sensitive ? (field.value ? '[hidden — sensitive]' : '[empty — sensitive]') : field.value ? JSON.stringify(field.value.slice(0, 80)) : '(empty)'
      lines.push(`  ${field.ref} · ${field.label || field.name || '(no label)'} · ${field.type} · ${value}`)
    }
  }
  if (tab.buttons.length) lines.push(`Buttons: ${tab.buttons.slice(0, 40).map((button) => `${button.ref}="${button.text}"`).join(', ')}`)
  if (tab.links.length) lines.push(`Links: ${tab.links.slice(0, 25).map((link) => `${link.text} → ${link.href}`).join(' | ')}`)
  lines.push('', 'Visible text:', tab.text.length > maxText ? `${tab.text.slice(0, maxText)}…` : tab.text)
  return lines.join('\n')
}

const PAYMENT_PAGE = /(checkout|payment|billing|\/pay\b|upgrade|subscribe|purchase)/i
const PAYMENT_BUTTON = /\b(pay|buy|purchase|place order|checkout|subscribe|upgrade plan|confirm payment|add funds|withdraw|transfer)\b/i

/** Clicking "Pay now" or anything on a checkout page is a payment, which is always manual. */
export function isPaymentAction(url: string, buttonText: string): boolean {
  return PAYMENT_BUTTON.test(buttonText) || (PAYMENT_PAGE.test(url) && /\b(confirm|continue|submit|proceed)\b/i.test(buttonText))
}
