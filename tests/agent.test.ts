import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultTools, executeTool, runAgent, toolsForMode, type ToolContext } from '../src/main/agent'
import { ProcessManager } from '../src/main/process-manager'
import { createNdjsonParser, streamChat, ToolsUnsupportedError, type OllamaMessage } from '../src/main/ollama-chat'
import { inspectProject } from '../src/main/project-service'
import type { ProjectSummary } from '../src/shared/contracts'

let root: string
let project: ProjectSummary

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dc-agent-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'server.ts'), 'app.post("/webhook", handler)')
  await writeFile(path.join(root, '.env'), 'SECRET=never-share')
  project = await inspectProject(root)
})
afterAll(() => rm(root, { recursive: true, force: true }))

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    project, mode: 'supervised', requestId: 'r1', signal: new AbortController().signal, processes: new ProcessManager(),
    requestApproval: async () => true, applyWrite: async () => {}, scriptEnv: async () => ({}), ...overrides,
  }
}
const baseRun = () => ({ toolContext: { requestId: 'r1', processes: new ProcessManager(), requestApproval: async () => true, applyWrite: async () => {}, scriptEnv: async () => ({}) } })

describe('ndjson parser', () => {
  it('handles objects split across chunks', () => {
    const seen: unknown[] = []
    const parser = createNdjsonParser((value) => seen.push(value))
    parser.push('{"a":1}\n{"b"')
    parser.push(':2}\n{"c":3}')
    parser.flush()
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })
})

describe('streamChat', () => {
  it('streams tokens from a fake Ollama response', async () => {
    const body = ['{"message":{"role":"assistant","content":"Na"}}\n', '{"message":{"role":"assistant","content":"maste"}}\n{"done":true}\n']
    const fakeFetch = (async () => new Response(new ReadableStream({
      start(controller) { body.forEach((part) => controller.enqueue(new TextEncoder().encode(part))); controller.close() },
    }))) as typeof fetch
    const tokens: string[] = []
    const result = await streamChat({ model: 'x', messages: [], signal: new AbortController().signal, onToken: (t) => tokens.push(t), fetchImpl: fakeFetch })
    expect(result.content).toBe('Namaste')
    expect(tokens).toEqual(['Na', 'maste'])
  })

  it('detects models without tool support', async () => {
    const fakeFetch = (async () => new Response('{"error":"llama2 does not support tools"}', { status: 400 })) as typeof fetch
    await expect(streamChat({ model: 'x', messages: [], tools: [], signal: new AbortController().signal, onToken: () => {}, fetchImpl: fakeFetch }))
      .rejects.toBeInstanceOf(ToolsUnsupportedError)
  })
})

describe('agent tools', () => {
  it('reads project files but never .env', async () => {
    const ok = await executeTool({ function: { name: 'read_file', arguments: { path: 'src/server.ts' } } }, defaultTools(), ctx({ mode: 'guide' }))
    expect(ok.record.outcome).toBe('ok')
    expect(ok.result).toContain('/webhook')
    const blocked = await executeTool({ function: { name: 'read_file', arguments: '{"path":".env"}' } }, defaultTools(), ctx({ mode: 'autonomous' }))
    expect(blocked.record.outcome).toBe('error')
    expect(blocked.result).not.toContain('never-share')
  })

  it('blocks tools that do not exist', async () => {
    const result = await executeTool({ function: { name: 'run_shell', arguments: { cmd: 'rm -rf /' } } }, defaultTools(), ctx({ mode: 'autonomous' }))
    expect(result.record.outcome).toBe('blocked')
    expect(result.record.decision).toBe('deny')
  })
})

describe('agent loop', () => {
  it('runs a tool round then answers', async () => {
    const calls: OllamaMessage[][] = []
    const fakeStream: typeof streamChat = async ({ messages, onToken }) => {
      calls.push([...messages])
      if (calls.length === 1) return { content: '', toolCalls: [{ function: { name: 'search_code', arguments: { query: 'webhook' } } }] }
      onToken('Webhook src/server.ts mein hai.')
      return { content: 'Webhook src/server.ts mein hai.', toolCalls: [] }
    }
    const tools: string[] = []
    const result = await runAgent({
      project, notes: [], mode: 'supervised', model: 'x', history: [], userMessage: 'webhook kahan hai?',
      signal: new AbortController().signal, onToken: () => {}, onTool: (record) => tools.push(record.tool), streamImpl: fakeStream, ...baseRun(),
    })
    expect(result.content).toContain('src/server.ts')
    expect(tools).toEqual(['search_code'])
    const toolMessage = calls[1].find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('src/server.ts:1')
  })

  it('falls back to context-only answers when the model has no tool support', async () => {
    let attempt = 0
    const fakeStream: typeof streamChat = async ({ tools }) => {
      attempt++
      if (tools) throw new ToolsUnsupportedError('no tools')
      return { content: 'ok', toolCalls: [] }
    }
    const result = await runAgent({
      project, notes: [], mode: 'guide', model: 'x', history: [], userMessage: 'hi',
      signal: new AbortController().signal, onToken: () => {}, onTool: () => {}, streamImpl: fakeStream, ...baseRun(),
    })
    expect(result.content).toBe('ok')
    expect(attempt).toBe(2)
  })

  it('respects the emergency stop', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runAgent({
      project, notes: [], mode: 'guide', model: 'x', history: [], userMessage: 'hi',
      signal: controller.signal, onToken: () => {}, onTool: () => {}, streamImpl: async () => ({ content: '', toolCalls: [] }), ...baseRun(),
    })).rejects.toThrow(/Stopped/)
  })
})

describe('approvals and modes', () => {
  const editCall = { function: { name: 'edit_file', arguments: { path: 'src/server.ts', find: '"/webhook"', replace: '"/api/webhook"' } } }

  it('hides mutating tools from the model in guide mode', () => {
    const names = toolsForMode(defaultTools(), 'guide').map((tool) => tool.name)
    expect(names).toEqual(['list_files', 'read_file', 'search_code', 'read_terminal'])
  })

  it('asks before editing in supervised mode and shows a diff preview', async () => {
    let preview = ''
    let written = false
    const result = await executeTool(editCall, defaultTools(), ctx({
      requestApproval: async (input) => { preview = input.preview; return true },
      applyWrite: async () => { written = true },
    }))
    expect(preview).toContain('-app.post("/webhook", handler)')
    expect(preview).toContain('+app.post("/api/webhook", handler)')
    expect(written).toBe(true)
    expect(result.record).toMatchObject({ decision: 'ask', outcome: 'ok', category: 'edit_code' })
  })

  it('does nothing when the developer rejects', async () => {
    let written = false
    const result = await executeTool(editCall, defaultTools(), ctx({ requestApproval: async () => false, applyWrite: async () => { written = true } }))
    expect(written).toBe(false)
    expect(result.record.outcome).toBe('blocked')
    expect(result.result).toMatch(/rejected/)
  })

  it('edits without asking in autonomous mode but still asks before installs', async () => {
    let asked = 0
    const approve = async () => { asked++; return false }
    await executeTool(editCall, defaultTools(), ctx({ mode: 'autonomous', requestApproval: approve }))
    expect(asked).toBe(0)
    await executeTool({ function: { name: 'install_package', arguments: { packages: ['razorpay'] } } }, defaultTools(), ctx({ mode: 'autonomous', requestApproval: approve }))
    expect(asked).toBe(1)
  })

  it('rejects unsafe package names and unknown scripts before asking', async () => {
    let asked = 0
    const approve = async () => { asked++; return true }
    const bad = await executeTool({ function: { name: 'install_package', arguments: { packages: ['left-pad && rm -rf /'] } } }, defaultTools(), ctx({ requestApproval: approve }))
    expect(bad.result).toMatch(/Invalid package/)
    const script = await executeTool({ function: { name: 'run_script', arguments: { script: 'deploy' } } }, defaultTools(), ctx({ requestApproval: approve }))
    expect(script.result).toMatch(/not a package.json script/)
    expect(asked).toBe(0)
  })

  it('never writes secret files', async () => {
    const result = await executeTool({ function: { name: 'write_file', arguments: { path: '.env', content: 'X=1' } } }, defaultTools(), ctx({ mode: 'autonomous' }))
    expect(result.result).toMatch(/Secret/)
  })
})
