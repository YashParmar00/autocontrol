import type { AgentTool } from './agent'
import { describeTab, isPaymentAction, type BrowserTabContext } from './browser-bridge'
import { ToolError } from './project-tools'
import { redactSecrets } from './redaction'

/**
 * Screen and browser tools. They are only offered to the model when the developer
 * enabled the feature, and they reach the outside world only through the interfaces
 * passed in (so they can be tested with fakes).
 */

export type ScreenCapability = {
  capture: () => Promise<string>
  describe: (imageBase64: string, question: string) => Promise<string>
}

export type BrowserCapability = {
  getContext: () => Promise<BrowserTabContext>
  fill: (fields: Array<{ ref: string; value: string; allowSensitive?: boolean }>) => Promise<Array<{ ref: string; ok: boolean; error?: string }>>
  click: (ref: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  openUrl: (url: string) => Promise<unknown>
  /** Resolve {{vault:NAME}} references in the main process. Returns null if the secret does not exist. */
  resolveVault?: (name: string) => Promise<string | null>
}

const VAULT_REF = /^\{\{vault:([A-Za-z0-9_.-]{1,64})\}\}$/

export function screenTools(screen: ScreenCapability): AgentTool[] {
  return [
    {
      name: 'look_at_screen',
      description: 'Take a screenshot of the developer\'s screen and get a description of what is visible (UI, text, errors). Ask a specific question.',
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'What you need to know, e.g. "Which step of the Razorpay webhook form is open and what fields are shown?"' } }, required: ['question'] },
      mutates: false,
      plan: async (args) => {
        const question = String(args.question ?? 'Describe the screen.').slice(0, 500)
        return {
          category: 'analyze_screen',
          summary: `look_at_screen "${question.slice(0, 60)}"`,
          run: async () => {
            const image = await screen.capture()
            return `Screen description (from a screenshot; may be imperfect):\n${redactSecrets(await screen.describe(image, question))}`
          },
        }
      },
    },
  ]
}

export function browserTools(browser: BrowserCapability): AgentTool[] {
  let lastTab: BrowserTabContext | null = null
  const fieldLabel = (ref: string) => {
    const field = lastTab?.fields.find((candidate) => candidate.ref === ref)
    return field ? `${field.label || field.name || ref}` : ref
  }
  return [
    {
      name: 'read_browser_tab',
      description: 'Read the developer\'s active Chrome tab: URL, headings, visible text, form fields (with refs like f3) and buttons (refs like b2). Password/OTP/card/API-key values are never included.',
      parameters: { type: 'object', properties: {} },
      mutates: false,
      plan: async () => ({
        category: 'analyze_screen',
        summary: 'read_browser_tab',
        run: async () => {
          lastTab = await browser.getContext()
          return redactSecrets(describeTab(lastTab))
        },
      }),
    },
    {
      name: 'fill_browser_fields',
      description: 'Type values into fields of the active tab, using refs from read_browser_tab. Does not submit. For a secret saved in the developer\'s vault use the value "{{vault:NAME}}" — you never see the secret itself.',
      parameters: {
        type: 'object',
        properties: { fields: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] } } },
        required: ['fields'],
      },
      mutates: true,
      plan: async (args) => {
        const raw = Array.isArray(args.fields) ? args.fields : []
        const fields = raw.slice(0, 30).map((entry) => {
          const item = (entry ?? {}) as Record<string, unknown>
          return { ref: String(item.ref ?? ''), value: String(item.value ?? '') }
        }).filter((field) => /^f\d{1,3}$/.test(field.ref))
        if (!fields.length) throw new ToolError('Give fields as [{ref:"f1", value:"..."}] using refs from read_browser_tab.')
        if (!lastTab) lastTab = await browser.getContext()
        const preview = fields.map((field) => {
          const vault = VAULT_REF.exec(field.value)
          const sensitive = lastTab?.fields.find((candidate) => candidate.ref === field.ref)?.sensitive
          const note = !vault && sensitive ? '   ⚠ sensitive field — will be refused (only vault secrets allowed)' : ''
          return `${field.ref} · ${fieldLabel(field.ref)} ← ${vault ? `🔒 vault secret "${vault[1]}" (hidden)` : JSON.stringify(field.value.slice(0, 120))}${note}`
        }).join('\n')
        return {
          category: 'submit_form',
          summary: `fill_browser_fields ${fields.map((field) => field.ref).join(',')}`,
          preview: `Fill on ${lastTab?.url ?? 'active tab'}:\n${preview}\n\n(Nothing is submitted.)`,
          run: async () => {
            const resolved = []
            for (const field of fields) {
              const vault = VAULT_REF.exec(field.value)
              if (vault) {
                const secret = browser.resolveVault ? await browser.resolveVault(vault[1]) : null
                if (secret === null) throw new ToolError(`Vault has no secret named "${vault[1]}". Ask the developer to add it in Security & activity → Vault.`)
                resolved.push({ ref: field.ref, value: secret, allowSensitive: true })
              } else {
                resolved.push({ ref: field.ref, value: field.value, allowSensitive: false })
              }
            }
            const results = await browser.fill(resolved)
            return results.map((result) => `${result.ref}: ${result.ok ? 'filled' : `NOT filled — ${result.error}`}`).join('\n')
          },
        }
      },
    },
    {
      name: 'click_browser_element',
      description: 'Click one button/link in the active tab using its ref (e.g. b3) from read_browser_tab. Payment buttons are always refused — the developer clicks those.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
      mutates: true,
      plan: async (args) => {
        const ref = String(args.ref ?? '')
        if (!/^[bf]\d{1,3}$/.test(ref)) throw new ToolError('Use a button ref like "b2" from read_browser_tab.')
        // Always know what is being clicked, so payment buttons can be detected.
        if (!lastTab) lastTab = await browser.getContext()
        const button = lastTab?.buttons.find((candidate) => candidate.ref === ref)
        const text = button?.text ?? ref
        const payment = isPaymentAction(lastTab?.url ?? '', text)
        return {
          category: payment ? 'payment' : 'submit_form',
          summary: `click_browser_element ${ref} "${text}"`,
          preview: `Click "${text}" on ${lastTab?.url ?? 'active tab'}`,
          run: async () => {
            const result = await browser.click(ref)
            return result.ok ? `Clicked "${result.text ?? text}". Read the tab again to see the result.` : `Click failed: ${result.error}`
          },
        }
      },
    },
    {
      name: 'open_browser_url',
      description: 'Open a URL in a new Chrome tab (e.g. a dashboard or documentation page).',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      mutates: true,
      plan: async (args) => {
        const url = String(args.url ?? '')
        if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ToolError('Give a full http(s) URL.')
        return {
          category: 'submit_form',
          summary: `open_browser_url ${url.slice(0, 80)}`,
          preview: `Open in Chrome: ${url}`,
          run: async () => { await browser.openUrl(url); return `Opened ${url}. Use read_browser_tab after it loads.` },
        }
      },
    },
  ]
}
