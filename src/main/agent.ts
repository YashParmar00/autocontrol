import type { ActionCategory, AutonomyMode, ChatMessage, PermissionDecision, ProjectSummary, TaskNote } from '../shared/contracts'
import { buildContext } from './context-builder'
import { streamChat, ToolsUnsupportedError, type OllamaMessage, type OllamaTool, type OllamaToolCall } from './ollama-chat'
import { decide } from './permission-engine'
import { listProjectFiles, readProjectFile, searchProject, ToolError } from './project-tools'
import { redactSecrets } from './redaction'

/**
 * Agent loop: build context → stream answer → execute any (permission-checked) tool
 * calls → feed results back → repeat. Only read-only tools exist in v0.2.0.
 */

const MAX_TOOL_ROUNDS = 4
const MAX_TOOL_RESULT_CHARS = 8_000
const HISTORY_TURNS = 12

export const AGENT_TOOLS: Array<OllamaTool & { category: ActionCategory }> = [
  {
    type: 'function',
    category: 'read_project',
    function: {
      name: 'list_files',
      description: 'List files and folders in the selected project. Optionally restrict to a sub-directory.',
      parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Relative sub-directory, e.g. "src/components". Empty for root.' } } },
    },
  },
  {
    type: 'function',
    category: 'read_project',
    function: {
      name: 'read_file',
      description: 'Read a text file from the selected project. Secret files (.env, keys, credentials) are blocked.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path, e.g. "src/server/payment.ts".' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    category: 'read_project',
    function: {
      name: 'search_code',
      description: 'Case-insensitive text search across project source files. Returns file:line matches.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for, e.g. "razorpay".' } }, required: ['query'] },
    },
  },
]

export type ToolAuditRecord = { category: ActionCategory; tool: string; summary: string; decision: PermissionDecision; outcome: 'ok' | 'error' | 'blocked' }

export type AgentRunOptions = {
  project: ProjectSummary | null
  notes: TaskNote[]
  mode: AutonomyMode
  model: string
  history: ChatMessage[]
  userMessage: string
  signal: AbortSignal
  onToken: (text: string) => void
  onTool: (record: ToolAuditRecord) => void
  streamImpl?: typeof streamChat
}

function parseArguments(raw: OllamaToolCall['function']['arguments']): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
  }
  return {}
}

export async function executeTool(call: OllamaToolCall, project: ProjectSummary | null, mode: AutonomyMode): Promise<{ result: string; record: ToolAuditRecord }> {
  const name = call.function?.name ?? 'unknown'
  const args = parseArguments(call.function?.arguments)
  const definition = AGENT_TOOLS.find((tool) => tool.function.name === name)
  const summary = `${name}(${redactSecrets(JSON.stringify(args)).slice(0, 120)})`
  if (!definition) {
    return { result: `Error: tool "${name}" does not exist.`, record: { category: 'run_command', tool: name, summary, decision: 'deny', outcome: 'blocked' } }
  }
  const decision = decide(definition.category, mode)
  if (decision !== 'allow') {
    return {
      result: `Blocked: ${name} needs developer approval in the current mode. Explain what you would do instead.`,
      record: { category: definition.category, tool: name, summary, decision, outcome: 'blocked' },
    }
  }
  if (!project) {
    return { result: 'Error: no project is selected.', record: { category: definition.category, tool: name, summary, decision, outcome: 'error' } }
  }
  try {
    let result: string
    if (name === 'list_files') result = listProjectFiles(project, typeof args.directory === 'string' ? args.directory : '')
    else if (name === 'read_file') result = await readProjectFile(project.path, String(args.path ?? ''))
    else result = await searchProject(project.path, project, String(args.query ?? ''))
    if (result.length > MAX_TOOL_RESULT_CHARS) result = `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`
    return { result, record: { category: definition.category, tool: name, summary, decision, outcome: 'ok' } }
  } catch (error) {
    const message = error instanceof ToolError ? error.message : 'Tool failed.'
    return { result: `Error: ${message}`, record: { category: definition.category, tool: name, summary, decision, outcome: 'error' } }
  }
}

export async function runAgent(options: AgentRunOptions): Promise<{ content: string; toolTrace: string[] }> {
  const stream = options.streamImpl ?? streamChat
  let toolsEnabled = true
  const toolTrace: string[] = []

  const history: OllamaMessage[] = options.history
    .slice(-HISTORY_TURNS)
    .map((message) => ({ role: message.role, content: redactSecrets(message.content) }))

  const buildMessages = async (): Promise<OllamaMessage[]> => {
    const context = await buildContext({
      project: options.project,
      notes: options.notes,
      mode: options.mode,
      userMessage: options.userMessage,
      toolsEnabled,
    })
    return [{ role: 'system', content: context.systemPrompt }, ...history, { role: 'user', content: redactSecrets(options.userMessage) }]
  }

  let messages = await buildMessages()
  let finalContent = ''

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (options.signal.aborted) throw new DOMException('Stopped', 'AbortError')
    const allowTools = toolsEnabled && round < MAX_TOOL_ROUNDS
    let result
    try {
      result = await stream({
        model: options.model,
        messages,
        tools: allowTools ? AGENT_TOOLS.map(({ category: _category, ...tool }) => tool) : undefined,
        signal: options.signal,
        onToken: options.onToken,
      })
    } catch (error) {
      if (error instanceof ToolsUnsupportedError && toolsEnabled) {
        // Older/small models: fall back to context-only answers.
        toolsEnabled = false
        messages = await buildMessages()
        round--
        continue
      }
      throw error
    }

    finalContent += result.content
    if (!result.toolCalls.length) break

    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      if (options.signal.aborted) throw new DOMException('Stopped', 'AbortError')
      const { result: toolResult, record } = await executeTool(call, options.project, options.mode)
      options.onTool(record)
      toolTrace.push(record.summary)
      messages.push({ role: 'tool', content: toolResult, tool_name: record.tool })
    }
    if (finalContent && !finalContent.endsWith('\n')) {
      finalContent += '\n\n'
      options.onToken('\n\n')
    }
  }

  return { content: redactSecrets(finalContent.trim()), toolTrace }
}
