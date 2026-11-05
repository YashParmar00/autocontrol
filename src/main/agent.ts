import type { ActionCategory, AutonomyMode, ChatMessage, PermissionDecision, ProjectSummary, TaskNote } from '../shared/contracts'
import { buildContext } from './context-builder'
import { renderDiff } from './diff'
import { streamChat, ToolsUnsupportedError, type OllamaMessage, type OllamaTool, type OllamaToolCall } from './ollama-chat'
import { decide } from './permission-engine'
import { installArgs, PACKAGE_SPEC, ProcessManager, SCRIPT_NAME } from './process-manager'
import { listProjectFiles, planEdit, planWrite, readProjectFile, searchProject, ToolError, type PlannedWrite } from './project-tools'
import { redactSecrets } from './redaction'

/**
 * Agent loop: build context → stream answer → execute (permission-checked) tool calls
 * → feed results back → repeat. Every tool is planned first (validated, preview built),
 * then the permission engine decides allow / ask (human approval) / deny.
 */

const MAX_TOOL_ROUNDS = 6
const MAX_TOOL_RESULT_CHARS = 8_000
const HISTORY_TURNS = 12
const TEST_SCRIPT = /(^|:)(test|tests|lint|typecheck|type-check|check|vitest|jest)(:|$)/i

export type ToolContext = {
  project: ProjectSummary | null
  mode: AutonomyMode
  requestId: string
  signal: AbortSignal
  processes: ProcessManager
  requestApproval: (input: { tool: string; category: ActionCategory; summary: string; preview: string }) => Promise<boolean>
  applyWrite: (plan: PlannedWrite, tool: string) => Promise<void>
  /** Extra environment for scripts (credential vault). Values never reach the model. */
  scriptEnv: () => Promise<Record<string, string>>
}

export type PlannedAction = {
  category: ActionCategory
  summary: string
  preview?: string
  run: () => Promise<string>
}

export type AgentTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** True when the tool can change something. Mutating tools are hidden from the model in guide mode. */
  mutates: boolean
  plan: (args: Record<string, unknown>, ctx: ToolContext) => Promise<PlannedAction>
}

function requireProject(ctx: ToolContext): ProjectSummary {
  if (!ctx.project) throw new ToolError('No project is selected. Ask the developer to select the project folder.')
  return ctx.project
}

function requireScript(project: ProjectSummary, raw: unknown): string {
  const script = String(raw ?? '').trim()
  if (!SCRIPT_NAME.test(script)) throw new ToolError('Invalid script name.')
  if (!project.scripts.includes(script)) throw new ToolError(`"${script}" is not a package.json script. Available: ${project.scripts.join(', ') || 'none'}`)
  return script
}

function formatRun(label: string, result: { exitCode: number | null; timedOut: boolean; output: string }): string {
  const status = result.timedOut ? 'TIMED OUT (killed)' : `exit code ${result.exitCode}`
  const output = result.output.length > 6_000 ? `…${result.output.slice(-6_000)}` : result.output
  return `${label}: ${status}\n${output || '(no output)'}`
}

export function defaultTools(): AgentTool[] {
  const writeAction = (plan: PlannedWrite, tool: string, ctx: ToolContext): PlannedAction => ({
    category: 'edit_code',
    summary: `${tool} ${plan.relative}${plan.before === null ? ' (new file)' : ''}`,
    preview: renderDiff(plan.relative, plan.before === null ? null : redactSecrets(plan.before), redactSecrets(plan.after)),
    run: async () => {
      await ctx.applyWrite(plan, tool)
      return `Saved ${plan.relative}. A checkpoint was created; the developer can undo it from Security & activity.`
    },
  })

  return [
    {
      name: 'list_files',
      description: 'List files and folders in the selected project. Optionally restrict to a sub-directory.',
      parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Relative sub-directory, e.g. "src/components". Empty for root.' } } },
      mutates: false,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        return { category: 'read_project', summary: `list_files ${String(args.directory ?? '') || '/'}`, run: async () => listProjectFiles(project, typeof args.directory === 'string' ? args.directory : '') }
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the selected project. Secret files (.env, keys, credentials) are blocked.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path, e.g. "src/server/payment.ts".' } }, required: ['path'] },
      mutates: false,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        return { category: 'read_project', summary: `read_file ${String(args.path ?? '')}`, run: () => readProjectFile(project.path, String(args.path ?? '')) }
      },
    },
    {
      name: 'search_code',
      description: 'Case-insensitive text search across project source files. Returns file:line matches.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for, e.g. "razorpay".' } }, required: ['query'] },
      mutates: false,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        return { category: 'read_project', summary: `search_code "${String(args.query ?? '')}"`, run: () => searchProject(project.path, project, String(args.query ?? '')) }
      },
    },
    {
      name: 'write_file',
      description: 'Create a new file or replace an existing file with the full content given. Prefer edit_file for small changes to existing files.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete new file content.' } }, required: ['path', 'content'] },
      mutates: true,
      plan: async (args, ctx) => writeAction(await planWrite(requireProject(ctx).path, String(args.path ?? ''), args.content), 'write_file', ctx),
    },
    {
      name: 'edit_file',
      description: 'Replace one exact snippet in an existing file. "find" must match the current file text exactly and appear once (include a few surrounding lines).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] },
      mutates: true,
      plan: async (args, ctx) => writeAction(await planEdit(requireProject(ctx).path, String(args.path ?? ''), args.find, args.replace), 'edit_file', ctx),
    },
    {
      name: 'run_script',
      description: 'Run a package.json script to completion (tests, lint, build) and return its output. Max 3 minutes. Do not use for dev servers — use start_process.',
      parameters: { type: 'object', properties: { script: { type: 'string', description: 'Script name from package.json, e.g. "test".' } }, required: ['script'] },
      mutates: true,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        const script = requireScript(project, args.script)
        const label = `${project.packageManager ?? 'npm'} run ${script}`
        return {
          category: TEST_SCRIPT.test(script) ? 'run_tests' : 'run_command',
          summary: `run_script ${script}`,
          preview: `$ ${label}\n(in ${project.path})`,
          run: async () => formatRun(label, await ctx.processes.run({
            cwd: project.path, manager: project.packageManager, args: project.packageManager === 'Yarn' ? [script] : ['run', script],
            env: await ctx.scriptEnv(), timeoutMs: 180_000, signal: ctx.signal,
          })),
        }
      },
    },
    {
      name: 'start_process',
      description: 'Start a long-running package.json script in the background (e.g. "dev"). Returns a process id; read its output later with read_terminal.',
      parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
      mutates: true,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        const script = requireScript(project, args.script)
        return {
          category: 'run_command',
          summary: `start_process ${script}`,
          preview: `$ ${project.packageManager ?? 'npm'} run ${script}   (background)`,
          run: async () => {
            const info = ctx.processes.start({ cwd: project.path, manager: project.packageManager, script, env: await ctx.scriptEnv() })
            await new Promise((resolve) => setTimeout(resolve, 3_000))
            return `Started process ${info.id}.\n${ctx.processes.read(info.id, 3_000)}`
          },
        }
      },
    },
    {
      name: 'read_terminal',
      description: 'Read recent output of processes started by this app (dev servers, scripts). Without an id, lists the processes.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Process id from start_process or list.' } } },
      mutates: false,
      plan: async (args, ctx) => ({
        category: 'read_terminal',
        summary: `read_terminal ${String(args.id ?? '') || '(list)'}`,
        run: async () => {
          if (!args.id) {
            const list = ctx.processes.list()
            return list.length ? list.map((p) => `${p.id}  ${p.label}  ${p.running ? 'running' : `exited ${p.exitCode}`}`).join('\n') : 'No processes are running.'
          }
          try { return ctx.processes.read(String(args.id)) } catch (error) { throw new ToolError(error instanceof Error ? error.message : 'Unknown process.') }
        },
      }),
    },
    {
      name: 'stop_process',
      description: 'Stop a background process started by this app.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      mutates: true,
      plan: async (args, ctx) => ({
        // Stopping only ever reduces what is running, so it is treated like a read.
        category: 'read_terminal',
        summary: `stop_process ${String(args.id ?? '')}`,
        run: async () => (ctx.processes.stop(String(args.id ?? '')) ? 'Stopped.' : 'No such process.'),
      }),
    },
    {
      name: 'install_package',
      description: 'Install npm packages into the project (e.g. ["razorpay"]). Always needs developer approval.',
      parameters: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' } }, dev: { type: 'boolean' } }, required: ['packages'] },
      mutates: true,
      plan: async (args, ctx) => {
        const project = requireProject(ctx)
        const packages = (Array.isArray(args.packages) ? args.packages : [args.packages]).map((value) => String(value ?? '').trim()).filter(Boolean)
        if (!packages.length || packages.length > 10) throw new ToolError('Give 1–10 package names.')
        for (const name of packages) if (!PACKAGE_SPEC.test(name)) throw new ToolError(`Invalid package name: ${name}`)
        const argv = installArgs(project.packageManager, packages, args.dev === true)
        return {
          category: 'install_package',
          summary: `install_package ${packages.join(' ')}${args.dev === true ? ' (dev)' : ''}`,
          preview: `$ ${project.packageManager ?? 'npm'} ${argv.join(' ')}`,
          run: async () => formatRun(`install ${packages.join(' ')}`, await ctx.processes.run({
            cwd: project.path, manager: project.packageManager, args: argv, timeoutMs: 300_000, signal: ctx.signal,
          })),
        }
      },
    },
  ]
}

export type ToolAuditRecord = { category: ActionCategory; tool: string; summary: string; decision: PermissionDecision; outcome: 'ok' | 'error' | 'blocked' }

function parseArguments(raw: OllamaToolCall['function']['arguments']): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
  }
  return {}
}

export async function executeTool(call: OllamaToolCall, tools: AgentTool[], ctx: ToolContext): Promise<{ result: string; record: ToolAuditRecord }> {
  const name = call.function?.name ?? 'unknown'
  const args = parseArguments(call.function?.arguments)
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    return { result: `Error: tool "${name}" does not exist.`, record: { category: 'run_command', tool: name, summary: redactSecrets(`${name}(…)`), decision: 'deny', outcome: 'blocked' } }
  }

  let action: PlannedAction
  try {
    action = await tool.plan(args, ctx)
  } catch (error) {
    const message = error instanceof ToolError ? error.message : 'Tool failed.'
    return { result: `Error: ${message}`, record: { category: 'read_project', tool: name, summary: redactSecrets(`${name} → ${message}`).slice(0, 200), decision: 'allow', outcome: 'error' } }
  }

  const summary = redactSecrets(action.summary).slice(0, 200)
  const decision = decide(action.category, ctx.mode)
  const record = (outcome: ToolAuditRecord['outcome']): ToolAuditRecord => ({ category: action.category, tool: name, summary, decision, outcome })

  if (decision === 'deny') {
    return { result: `Blocked: "${name}" is not allowed in ${ctx.mode} mode. Tell the developer the exact steps to do it themselves.`, record: record('blocked') }
  }
  if (decision === 'ask') {
    const approved = await ctx.requestApproval({ tool: name, category: action.category, summary, preview: action.preview ?? summary })
    if (!approved) {
      return { result: `The developer rejected "${summary}". Do not retry the same action; ask what they want instead.`, record: record('blocked') }
    }
  }

  try {
    let result = await action.run()
    if (result.length > MAX_TOOL_RESULT_CHARS) result = `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`
    return { result, record: record('ok') }
  } catch (error) {
    const message = error instanceof ToolError ? error.message : error instanceof Error ? error.message : 'Tool failed.'
    return { result: `Error: ${redactSecrets(message)}`, record: record('error') }
  }
}

export type AgentRunOptions = {
  project: ProjectSummary | null
  notes: TaskNote[]
  mode: AutonomyMode
  model: string
  history: ChatMessage[]
  userMessage: string
  /** Base64 PNG/JPEG images attached to this turn (screen awareness). */
  images?: string[]
  signal: AbortSignal
  onToken: (text: string) => void
  onTool: (record: ToolAuditRecord) => void
  toolContext: Omit<ToolContext, 'project' | 'mode' | 'signal'>
  tools?: AgentTool[]
  /** Extra text appended to the system prompt (e.g. current browser tab). */
  extraContext?: string
  streamImpl?: typeof streamChat
}

export function toolsForMode(tools: AgentTool[], mode: AutonomyMode): AgentTool[] {
  return mode === 'guide' ? tools.filter((tool) => !tool.mutates) : tools
}

export async function runAgent(options: AgentRunOptions): Promise<{ content: string; toolTrace: string[] }> {
  const stream = options.streamImpl ?? streamChat
  const allTools = options.tools ?? defaultTools()
  const offered = toolsForMode(allTools, options.mode)
  const ctx: ToolContext = { ...options.toolContext, project: options.project, mode: options.mode, signal: options.signal }
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
      toolNames: offered.map((tool) => tool.name),
    })
    const system = options.extraContext ? `${context.systemPrompt}\n\n${options.extraContext}` : context.systemPrompt
    const user: OllamaMessage = { role: 'user', content: redactSecrets(options.userMessage) }
    if (options.images?.length) user.images = options.images
    return [{ role: 'system', content: system }, ...history, user]
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
        tools: allowTools ? offered.map(toOllamaTool) : undefined,
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
      const { result: toolResult, record } = await executeTool(call, offered, ctx)
      options.onTool(record)
      toolTrace.push(record.outcome === 'ok' ? record.summary : `${record.summary} [${record.outcome}]`)
      messages.push({ role: 'tool', content: toolResult, tool_name: record.tool })
    }
    if (finalContent && !finalContent.endsWith('\n')) {
      finalContent += '\n\n'
      options.onToken('\n\n')
    }
  }

  return { content: redactSecrets(finalContent.trim()), toolTrace }
}

function toOllamaTool(tool: AgentTool): OllamaTool {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}
