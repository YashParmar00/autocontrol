import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { defaultTools, executeTool, type ToolContext } from '../src/main/agent'
import { BrowserBridge, describeTab, isPaymentAction, type BrowserTabContext } from '../src/main/browser-bridge'
import { browserTools, screenTools, type BrowserCapability } from '../src/main/capability-tools'
import { ProcessManager } from '../src/main/process-manager'

const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`
const TOKEN = 'test-token-1234567890'
const PORT = 47999
let bridge: BrowserBridge

beforeAll(async () => {
  bridge = new BrowserBridge(() => TOKEN, PORT)
  await bridge.start()
})
afterAll(() => bridge.close())

function connect(origin: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}&v=0.4.0`, { origin })
    socket.on('open', () => resolve(socket))
    socket.on('error', reject)
  })
}

describe('browser bridge', () => {
  it('rejects web pages and wrong tokens', async () => {
    await expect(connect('https://evil.example', TOKEN)).rejects.toThrow()
    await expect(connect(EXT_ORIGIN, 'wrong-token-000000000')).rejects.toThrow()
    expect(bridge.status().connected).toBe(false)
  })

  it('round-trips requests with a paired extension', async () => {
    const socket = await connect(EXT_ORIGIN, TOKEN)
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'get_context') socket.send(JSON.stringify({ id: message.id, ok: true, result: { url: 'https://x.test' } }))
      if (message.type === 'fill') socket.send(JSON.stringify({ id: message.id, ok: false, error: 'nope' }))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(bridge.status()).toMatchObject({ connected: true, extensionVersion: '0.4.0' })
    await expect(bridge.request('get_context')).resolves.toEqual({ url: 'https://x.test' })
    await expect(bridge.request('fill', { fields: [] })).rejects.toThrow('nope')
    socket.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(bridge.status().connected).toBe(false)
    await expect(bridge.request('get_context')).rejects.toThrow(/not connected/)
  })
})

const tab: BrowserTabContext = {
  url: 'https://dashboard.razorpay.com/app/webhooks/new',
  title: 'Webhooks',
  headings: ['Create webhook'],
  text: 'Webhook URL Secret Active events',
  fields: [
    { ref: 'f1', label: 'Webhook URL', type: 'url', name: 'url', value: '', sensitive: false },
    { ref: 'f2', label: 'Secret', type: 'password', name: 'secret', value: '•', sensitive: true },
  ],
  buttons: [{ ref: 'b1', text: 'Create Webhook', tag: 'button' }, { ref: 'b2', text: 'Pay now', tag: 'button' }],
  links: [],
  capturedAt: new Date().toISOString(),
}

function fakeBrowser(): BrowserCapability & { filled: unknown[]; clicked: string[] } {
  const state = { filled: [] as unknown[], clicked: [] as string[] }
  return {
    ...state,
    getContext: async () => tab,
    fill: async (fields) => { state.filled.push(...fields); return fields.map((field) => ({ ref: field.ref, ok: true })) },
    click: async (ref) => { state.clicked.push(ref); return { ok: true, text: 'Create Webhook' } },
    openUrl: async () => ({}),
    resolveVault: async (name) => (name === 'RAZORPAY_WEBHOOK_SECRET' ? 'whsec_real_value' : null),
    get filledList() { return state.filled },
  } as never
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { project: null, mode: 'supervised', requestId: 'r', signal: new AbortController().signal, processes: new ProcessManager(), requestApproval: async () => true, applyWrite: async () => {}, scriptEnv: async () => ({}), ...overrides }
}

describe('browser tools', () => {
  it('describes tabs without sensitive values', () => {
    const text = describeTab(tab)
    expect(text).toContain('f1 · Webhook URL')
    expect(text).toContain('[hidden — sensitive]')
    expect(text).not.toContain('•')
  })

  it('detects payment clicks', () => {
    expect(isPaymentAction('https://shop.test/cart', 'Pay now')).toBe(true)
    expect(isPaymentAction('https://shop.test/checkout', 'Continue')).toBe(true)
    expect(isPaymentAction('https://dashboard.razorpay.com/webhooks', 'Create Webhook')).toBe(false)
  })

  it('fills fields after approval and resolves vault refs without showing the secret', async () => {
    const browser = fakeBrowser()
    let preview = ''
    const tools = [...defaultTools(), ...browserTools(browser)]
    const result = await executeTool({ function: { name: 'fill_browser_fields', arguments: { fields: [
      { ref: 'f1', value: 'https://api.myshop.in/razorpay/webhook' },
      { ref: 'f2', value: '{{vault:RAZORPAY_WEBHOOK_SECRET}}' },
    ] } } }, tools, ctx({ requestApproval: async (input) => { preview = input.preview; return true } }))
    expect(result.record).toMatchObject({ decision: 'ask', outcome: 'ok', category: 'submit_form' })
    expect(preview).toContain('Webhook URL')
    expect(preview).toContain('vault secret "RAZORPAY_WEBHOOK_SECRET" (hidden)')
    expect(preview).not.toContain('whsec_real_value')
    expect(result.result).not.toContain('whsec_real_value')
    const filled = (browser as unknown as { filled: Array<{ ref: string; value: string; allowSensitive: boolean }> }).filled
    expect(filled).toEqual([
      { ref: 'f1', value: 'https://api.myshop.in/razorpay/webhook', allowSensitive: false },
      { ref: 'f2', value: 'whsec_real_value', allowSensitive: true },
    ])
  })

  it('reports a missing vault secret instead of filling', async () => {
    const tools = browserTools(fakeBrowser())
    const result = await executeTool({ function: { name: 'fill_browser_fields', arguments: { fields: [{ ref: 'f2', value: '{{vault:NOPE}}' }] } } }, tools, ctx())
    expect(result.record.outcome).toBe('error')
    expect(result.result).toMatch(/no secret named "NOPE"/)
  })

  it('never clicks payment buttons, even in autonomous mode', async () => {
    const browser = fakeBrowser()
    const tools = browserTools(browser)
    const pay = await executeTool({ function: { name: 'click_browser_element', arguments: { ref: 'b2' } } }, tools, ctx({ mode: 'autonomous' }))
    expect(pay.record).toMatchObject({ category: 'payment', decision: 'deny', outcome: 'blocked' })
    const create = await executeTool({ function: { name: 'click_browser_element', arguments: { ref: 'b1' } } }, tools, ctx({ mode: 'autonomous' }))
    expect(create.record).toMatchObject({ category: 'submit_form', decision: 'ask', outcome: 'ok' })
    expect((browser as unknown as { clicked: string[] }).clicked).toEqual(['b1'])
  })

  it('reads the screen through the vision describer and redacts', async () => {
    const tools = screenTools({ capture: async () => 'BASE64', describe: async (image, question) => `${image}:${question} API_KEY=leaked123` })
    const result = await executeTool({ function: { name: 'look_at_screen', arguments: { question: 'which step?' } } }, tools, ctx({ mode: 'guide' }))
    expect(result.record.outcome).toBe('ok')
    expect(result.result).toContain('BASE64:which step?')
    expect(result.result).not.toContain('leaked123')
  })
})
