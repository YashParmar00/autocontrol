import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectFileEntry, ProjectSummary } from '../shared/contracts'

const IGNORED_DIRS = new Set([
  '.git', '.next', '.nuxt', '.turbo', '.vercel', '.yarn', '.idea', '.vscode',
  'node_modules', 'dist', 'build', 'coverage', 'vendor', 'out', 'release',
  '.cache', '.expo', '.output', 'target', 'Pods',
])
const SENSITIVE_FILE = /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|credentials|secrets?)/i
const MAX_ENTRIES = 800
const MAX_DEPTH = 5

function isSensitiveName(name: string): boolean {
  return SENSITIVE_FILE.test(name)
}

function packageStack(packageJson: Record<string, unknown>): { stack: string[]; manager: string | null; scripts: string[] } {
  const deps = {
    ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {}),
  }
  const stack: string[] = []
  const add = (match: string, label: string) => { if (match in deps) stack.push(label) }
  add('react', 'React')
  add('next', 'Next.js')
  add('vite', 'Vite')
  add('express', 'Express')
  add('mongoose', 'Mongoose')
  add('prisma', 'Prisma')
  add('@prisma/client', 'Prisma Client')
  add('typescript', 'TypeScript')
  add('socket.io', 'Socket.IO')
  add('electron', 'Electron')
  add('tailwindcss', 'Tailwind CSS')
  add('zod', 'Zod')
  if (packageJson.workspaces) stack.push('npm workspaces')
  const scriptsObject = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts as Record<string, unknown> : {}
  const scripts = Object.keys(scriptsObject).slice(0, 30)
  return {
    stack: [...new Set(stack)],
    manager: null,
    scripts,
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path.join(root, 'package.json'), 'utf8')
    if (raw.length > 256_000) return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function inspectProject(selectedPath: string): Promise<ProjectSummary> {
  const root = await realpath(selectedPath)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) throw new Error('Selected path is not a directory.')

  const files: ProjectFileEntry[] = []
  let truncated = false

  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_ENTRIES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (isSensitiveName(entry.name) || entry.isSymbolicLink()) continue
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
      const relativePath = relative ? path.posix.join(relative, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      let stat
      try { stat = await lstat(absolute) } catch { continue }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        files.push({ name: entry.name, relativePath, kind: 'directory' })
        await walk(absolute, relativePath, depth + 1)
      } else if (stat.isFile()) {
        files.push({ name: entry.name, relativePath, kind: 'file' })
      }
    }
  }

  await walk(root, '', 0)
  const pkg = await readPackageJson(root)
  const detected = pkg ? packageStack(pkg) : { stack: [], manager: null, scripts: [] }
  const manager = await detectPackageManager(root)
  const projectName = pkg && typeof pkg.name === 'string' ? pkg.name : path.basename(root)

  return {
    name: projectName,
    path: root,
    detectedStack: detected.stack,
    packageManager: manager,
    scripts: detected.scripts,
    files,
    fileCount: files.filter((file) => file.kind === 'file').length,
    truncated,
    inspectedAt: new Date().toISOString(),
  }
}

async function detectPackageManager(root: string): Promise<string | null> {
  const candidates: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'Yarn'], ['package-lock.json', 'npm'], ['bun.lockb', 'Bun'], ['bun.lock', 'Bun'],
  ]
  for (const [filename, manager] of candidates) {
    try { await lstat(path.join(root, filename)); return manager } catch { /* continue */ }
  }
  return null
}
