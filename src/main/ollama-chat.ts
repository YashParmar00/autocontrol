/**
 * Minimal streaming client for Ollama's /api/chat (loopback only).
 * Kept free of Electron imports so it can be unit-tested.
 */

export const OLLAMA_CHAT_URL = 'http://127.0.0.1:11434/api/chat'

export type OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> | string } }

export type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export type OllamaTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export class ToolsUnsupportedError extends Error {}

export type StreamResult = { content: string; toolCalls: OllamaToolCall[] }

/** Parse a chunk of NDJSON, carrying any partial trailing line over to the next call. */
export function createNdjsonParser(onObject: (value: Record<string, unknown>) => void): { push(chunk: string): void; flush(): void } {
  let buffer = ''
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try { onObject(JSON.parse(trimmed) as Record<string, unknown>) } catch { /* ignore malformed line */ }
  }
  return {
    push(chunk: string) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(handleLine)
    },
    flush() {
      handleLine(buffer)
      buffer = ''
    },
  }
}

export async function streamChat(options: {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  signal: AbortSignal
  onToken: (text: string) => void
  fetchImpl?: typeof fetch
}): Promise<StreamResult> {
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      ...(options.tools?.length ? { tools: options.tools } : {}),
      options: { temperature: 0.2, num_ctx: 8192 },
    }),
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    if (response.status === 400 && /does not support tools/i.test(detail)) throw new ToolsUnsupportedError(detail)
    if (response.status === 404) throw new Error(`Model "${options.model}" is not installed. Run: ollama pull ${options.model}`)
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  let content = ''
  const toolCalls: OllamaToolCall[] = []
  let streamError: string | null = null
  const parser = createNdjsonParser((value) => {
    if (typeof value.error === 'string') { streamError = value.error; return }
    const message = value.message as Partial<OllamaMessage> | undefined
    if (!message) return
    if (typeof message.content === 'string' && message.content) {
      content += message.content
      options.onToken(message.content)
    }
    if (Array.isArray(message.tool_calls)) toolCalls.push(...message.tool_calls)
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.flush()
  if (streamError) {
    if (/does not support tools/i.test(streamError)) throw new ToolsUnsupportedError(streamError)
    throw new Error(streamError)
  }
  return { content, toolCalls }
}
