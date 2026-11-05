import { spawn, type ChildProcess } from 'node:child_process'
import { redactSecrets } from './redaction'

/**
 * Runs project scripts (never arbitrary shell strings). Script and package names are
 * validated so nothing the model writes can reach a shell as code.
 */

export const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/
export const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9.^~<>=*|+-]{1,40})?$/
const MAX_BUFFER_CHARS = 200_000

export type ScriptResult = { exitCode: number | null; timedOut: boolean; output: string }
export type ManagedProcess = {
  id: string
  label: string
  startedAt: string
  running: boolean
  exitCode: number | null
}

type Entry = ManagedProcess & { child: ChildProcess; buffer: string }

export type Redactor = (text: string) => string

function packageManagerCommand(manager: string | null): string {
  const base = manager === 'pnpm' ? 'pnpm' : manager === 'Yarn' ? 'yarn' : manager === 'Bun' ? 'bun' : 'npm'
  return process.platform === 'win32' && base !== 'bun' ? `${base}.cmd` : base
}

export function scriptArgs(manager: string | null, script: string): string[] {
  return manager === 'Yarn' ? [script] : ['run', script]
}

export function installArgs(manager: string | null, packages: string[], dev: boolean): string[] {
  if (manager === 'Yarn') return ['add', ...(dev ? ['--dev'] : []), ...packages]
  if (manager === 'pnpm' || manager === 'Bun') return ['add', ...(dev ? ['-D'] : []), ...packages]
  return ['install', ...(dev ? ['--save-dev'] : []), ...packages]
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
  }
}

function launch(cwd: string, command: string, args: string[], env: Record<string, string>): ChildProcess {
  for (const arg of args) {
    // Defense in depth: on Windows .cmd files need a shell, so refuse any shell metacharacter.
    if (/[&|<>^%"`$;\r\n]/.test(arg)) throw new Error(`Refusing unsafe argument: ${arg}`)
  }
  return spawn(command, args, {
    cwd,
    env: { ...process.env, ...env, FORCE_COLOR: '0', CI: '1' },
    shell: process.platform === 'win32',
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

export class ProcessManager {
  private processes = new Map<string, Entry>()
  private foreground = new Set<ChildProcess>()

  constructor(private redact: Redactor = redactSecrets) {}

  /** Run to completion (tests, builds, installs) with a timeout. */
  run(options: { cwd: string; manager: string | null; args: string[]; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<ScriptResult> {
    return new Promise((resolve) => {
      let output = ''
      let timedOut = false
      let child: ChildProcess
      try {
        child = launch(options.cwd, packageManagerCommand(options.manager), options.args, options.env ?? {})
      } catch (error) {
        resolve({ exitCode: null, timedOut: false, output: error instanceof Error ? error.message : 'Could not start.' })
        return
      }
      this.foreground.add(child)
      const append = (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > MAX_BUFFER_CHARS) output = output.slice(-MAX_BUFFER_CHARS)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      const timer = setTimeout(() => { timedOut = true; killTree(child) }, options.timeoutMs)
      const onAbort = () => killTree(child)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (exitCode: number | null, extra = '') => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.foreground.delete(child)
        resolve({ exitCode, timedOut, output: this.redact(stripAnsi(output + extra)) })
      }
      child.on('error', (error) => finish(null, `\n${error.message}`))
      child.on('close', (code) => finish(code))
    })
  }

  /** Start a long-running script (dev server, watcher) whose output can be read later. */
  start(options: { cwd: string; manager: string | null; script: string; env?: Record<string, string> }): ManagedProcess {
    const child = launch(options.cwd, packageManagerCommand(options.manager), scriptArgs(options.manager, options.script), options.env ?? {})
    const entry: Entry = {
      id: crypto.randomUUID().slice(0, 8),
      label: options.script,
      startedAt: new Date().toISOString(),
      running: true,
      exitCode: null,
      child,
      buffer: '',
    }
    const append = (chunk: Buffer) => {
      entry.buffer += chunk.toString('utf8')
      if (entry.buffer.length > MAX_BUFFER_CHARS) entry.buffer = entry.buffer.slice(-MAX_BUFFER_CHARS)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => { entry.buffer += `\n${error.message}`; entry.running = false })
    child.on('close', (code) => { entry.running = false; entry.exitCode = code })
    this.processes.set(entry.id, entry)
    return this.describe(entry)
  }

  read(id: string, tailChars = 6_000): string {
    const entry = this.processes.get(id)
    if (!entry) throw new Error(`No process with id ${id}.`)
    const text = this.redact(stripAnsi(entry.buffer))
    const status = entry.running ? 'running' : `exited with code ${entry.exitCode}`
    return `[${entry.label} · ${status}]\n${text.length > tailChars ? `…${text.slice(-tailChars)}` : text || '(no output yet)'}`
  }

  stop(id: string): boolean {
    const entry = this.processes.get(id)
    if (!entry) return false
    killTree(entry.child)
    return true
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()].map((entry) => this.describe(entry)).reverse()
  }

  forget(id: string): void {
    const entry = this.processes.get(id)
    if (entry && !entry.running) this.processes.delete(id)
  }

  /** Emergency stop: kill every child process this app started. */
  stopAll(): number {
    let count = 0
    for (const child of this.foreground) { killTree(child); count++ }
    for (const entry of this.processes.values()) if (entry.running) { killTree(entry.child); count++ }
    return count
  }

  private describe(entry: Entry): ManagedProcess {
    return { id: entry.id, label: entry.label, startedAt: entry.startedAt, running: entry.running, exitCode: entry.exitCode }
  }
}
