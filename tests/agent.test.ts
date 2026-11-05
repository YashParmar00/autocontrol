import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeTool, runAgent } from '../src/main/agent'
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
    const ok = await executeTool({ function: { name: 'read_file', arguments: { path: 'src/server.ts' } } }, project, 'guide')
    expect(ok.record.outcome).toBe('ok')
    expect(ok.result).toContain('/webhook')
    const blocked = await executeTool({ function: { name: 'read_file', arguments: '{"path":".env"}' } }, project, 'autonomous')
    expect(blocked.record.outcome).toBe('error')
    expect(blocked.result).not.toContain('never-share')
  })

  it('blocks tools that do not exist', async () => {
    const result = await executeTool({ function: { name: 'run_shell', arguments: { cmd: 'rm -rf /' } } }, project, 'autonomous')
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
      signal: new AbortController().signal, onToken: () => {}, onTool: (record) => tools.push(record.tool), streamImpl: fakeStream,
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
      signal: new AbortController().signal, onToken: () => {}, onTool: () => {}, streamImpl: fakeStream,
    })
    expect(result.content).toBe('ok')
    expect(attempt).toBe(2)
  })

  it('respects the emergency stop', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runAgent({
      project, notes: [], mode: 'guide', model: 'x', history: [], userMessage: 'hi',
      signal: controller.signal, onToken: () => {}, onTool: () => {}, streamImpl: async () => ({ content: '', toolCalls: [] }),
    })).rejects.toThrow(/Stopped/)
  })
})
