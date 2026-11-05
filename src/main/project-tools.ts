import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectSummary } from '../shared/contracts'
import { redactSecrets } from './redaction'

/**
 * Read-only project tools the AI can call. Every path goes through `resolveSafe`,
 * which keeps reads inside the selected project and away from secret files.
 */

export const SENSITIVE_SEGMENT = /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|\.keystore$|\.jks$|^id_rsa|^id_ed25519|^id_ecdsa|credentials|secrets?(\.|$)|\.npmrc$|\.netrc$|\.pypirc$|^\.git$|^\.ssh$|^\.aws$|^\.docker$)/i
const IGNORED_SEGMENT = new Set(['node_modules', 'dist', 'build', 'out', 'release', '.next', '.turbo', 'coverage', '.cache'])
const MAX_READ_BYTES = 64_000
const MAX_SEARCH_FILES = 400
const MAX_SEARCH_HITS = 40
const TEXT_EXTENSIONS = /\.(m?[jt]sx?|cjs|json|md|mdx|txt|css|scss|sass|less|html?|vue|svelte|astro|ya?ml|toml|ini|prisma|graphql|gql|sql|py|rb|go|rs|java|kt|php|cs|c|cpp|h|hpp|sh|ps1|bat|cmd|xml|svg|env\.example)$/i

export class ToolError extends Error {}

export function isSensitivePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => SENSITIVE_SEGMENT.test(segment) && !/\.example$|\.sample$/i.test(segment))
}

/** Resolve a model-supplied path to an absolute path inside the project, or throw. */
export async function resolveSafe(root: string, requested: string): Promise<{ absolute: string; relative: string }> {
  if (typeof requested !== 'string' || !requested.trim()) throw new ToolError('A file path is required.')
  if (requested.includes('\0')) throw new ToolError('Invalid path.')
  const cleaned = requested.trim().replace(/^[/\\]+/, '')
  const absolute = path.resolve(root, cleaned)
  const relative = path.relative(root, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError('Path is outside the selected project.')
  }
  if (isSensitivePath(relative)) throw new ToolError('This file is protected (secrets/credentials) and is never shared with the AI.')
  if (relative.split(/[\\/]+/).some((segment) => IGNORED_SEGMENT.has(segment))) {
    throw new ToolError('Generated/dependency folders are not read.')
  }
  let real: string
  try { real = await realpath(absolute) } catch { throw new ToolError(`File not found: ${relative}`) }
  const realRelative = path.relative(await realpath(root), real)
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new ToolError('Path resolves outside the project.')
  return { absolute: real, relative: relative.split(path.sep).join('/') }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 2048)
  return sample.includes(0)
}

export async function readProjectFile(root: string, requested: string): Promise<string> {
  const { absolute, relative } = await resolveSafe(root, requested)
  const stat = await lstat(absolute)
  if (stat.isSymbolicLink()) throw new ToolError('Symbolic links are not followed.')
  if (!stat.isFile()) throw new ToolError(`${relative} is not a file.`)
  const buffer = await readFile(absolute)
  if (looksBinary(buffer)) throw new ToolError(`${relative} looks like a binary file.`)
  const truncated = buffer.length > MAX_READ_BYTES
  const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8')
  return `// ${relative}${truncated ? ` (first ${MAX_READ_BYTES} bytes of ${buffer.length})` : ''}\n${redactSecrets(text)}`
}

export function listProjectFiles(project: ProjectSummary, subdirectory = ''): string {
  const prefix = subdirectory.replace(/^[/\\]+|[/\\]+$/g, '').replace(/\\/g, '/')
  const entries = project.files.filter((file) => !prefix || file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`))
  if (!entries.length) return prefix ? `No entries under ${prefix}.` : 'Project has no scanned files.'
  const lines = entries.slice(0, 300).map((file) => `${file.kind === 'directory' ? 'd' : 'f'} ${file.relativePath}`)
  if (entries.length > 300) lines.push(`… ${entries.length - 300} more`)
  return lines.join('\n')
}

export async function searchProject(root: string, project: ProjectSummary, query: string): Promise<string> {
  const needle = typeof query === 'string' ? query.trim() : ''
  if (needle.length < 2) throw new ToolError('Search query must be at least 2 characters.')
  const lower = needle.toLowerCase()
  const hits: string[] = []
  const candidates = project.files.filter((file) => file.kind === 'file' && TEXT_EXTENSIONS.test(file.name)).slice(0, MAX_SEARCH_FILES)
  for (const file of candidates) {
    if (hits.length >= MAX_SEARCH_HITS) break
    if (file.relativePath.toLowerCase().includes(lower)) hits.push(`${file.relativePath}: (path match)`)
    let content: string
    try {
      const { absolute } = await resolveSafe(root, file.relativePath)
      const stat = await lstat(absolute)
      if (!stat.isFile() || stat.size > 512_000) continue
      content = await readFile(absolute, 'utf8')
    } catch { continue }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length && hits.length < MAX_SEARCH_HITS; index++) {
      if (lines[index].toLowerCase().includes(lower)) {
        hits.push(`${file.relativePath}:${index + 1}: ${redactSecrets(lines[index].trim()).slice(0, 200)}`)
      }
    }
  }
  return hits.length ? hits.join('\n') : `No matches for "${needle}".`
}

// ---------------------------------------------------------------------------
// v0.3.0 — writes (only ever called after the permission engine said yes)
// ---------------------------------------------------------------------------

const MAX_WRITE_BYTES = 512_000

/** Like resolveSafe, but the target may not exist yet. The parent directory must resolve inside the project. */
export async function resolveSafeForWrite(root: string, requested: string): Promise<{ absolute: string; relative: string; exists: boolean }> {
  if (typeof requested !== 'string' || !requested.trim()) throw new ToolError('A file path is required.')
  if (requested.includes('\0')) throw new ToolError('Invalid path.')
  const realRoot = await realpath(root)
  const cleaned = requested.trim().replace(/^[/\\]+/, '')
  const absolute = path.resolve(realRoot, cleaned)
  const relative = path.relative(realRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ToolError('Path is outside the selected project.')
  if (isSensitivePath(relative)) throw new ToolError('Secret/credential files cannot be written by the AI. Edit them yourself.')
  const segments = relative.split(/[\\/]+/)
  if (segments.some((segment) => IGNORED_SEGMENT.has(segment))) throw new ToolError('Generated/dependency folders are not written.')
  // Walk up to the nearest existing ancestor and make sure it is really inside the project.
  let ancestor = path.dirname(absolute)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      const rel = path.relative(realRoot, realAncestor)
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError('Path resolves outside the project.')
      break
    } catch (error) {
      if (error instanceof ToolError) throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new ToolError('Invalid path.')
      ancestor = parent
    }
  }
  let exists = false
  try {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink()) throw new ToolError('Symbolic links are not written.')
    if (!stat.isFile()) throw new ToolError('Target exists and is not a file.')
    exists = true
  } catch (error) {
    if (error instanceof ToolError) throw error
  }
  return { absolute, relative: segments.join('/'), exists }
}

const PLACEHOLDER = /\[REDACTED(?:_TOKEN|_PRIVATE_KEY)?\]/

/** The AI only ever sees redacted text. Writing a placeholder back would destroy the real secret. */
function assertNoPlaceholders(before: string | null, text: string): void {
  if (PLACEHOLDER.test(text) && !(before !== null && PLACEHOLDER.test(before))) {
    throw new ToolError('Content contains [REDACTED] placeholders. Those hide real secrets — never write them back. Use edit_file on the specific lines you need to change, without touching secret values.')
  }
}

export type PlannedWrite = { absolute: string; relative: string; before: string | null; after: string }

/** Prepare a full-file write. Nothing touches disk here. */
export async function planWrite(root: string, requested: string, content: unknown): Promise<PlannedWrite> {
  if (typeof content !== 'string') throw new ToolError('File content must be a string.')
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolError('Content is too large (max 512 KB).')
  const target = await resolveSafeForWrite(root, requested)
  const before = target.exists ? await readFile(target.absolute, 'utf8') : null
  assertNoPlaceholders(before, content)
  return { absolute: target.absolute, relative: target.relative, before, after: content }
}

/** Prepare an exact find/replace edit. `find` must occur exactly once. */
export async function planEdit(root: string, requested: string, find: unknown, replace: unknown): Promise<PlannedWrite> {
  if (typeof find !== 'string' || !find) throw new ToolError('"find" text is required.')
  if (typeof replace !== 'string') throw new ToolError('"replace" text must be a string.')
  if (PLACEHOLDER.test(replace) || PLACEHOLDER.test(find)) throw new ToolError('Edits must not include [REDACTED] placeholders — those lines hold secrets. Leave them unchanged.')
  const target = await resolveSafeForWrite(root, requested)
  if (!target.exists) throw new ToolError(`File not found: ${target.relative}. Use write_file to create it.`)
  const before = await readFile(target.absolute, 'utf8')
  const normalizedFind = before.includes('\r\n') && !find.includes('\r\n') ? find.replace(/\n/g, '\r\n') : find
  const first = before.indexOf(normalizedFind)
  if (first < 0) throw new ToolError(`The "find" text was not found in ${target.relative}. Read the file again and copy the exact text.`)
  if (before.indexOf(normalizedFind, first + 1) >= 0) throw new ToolError(`The "find" text appears more than once in ${target.relative}. Include more surrounding lines.`)
  const normalizedReplace = normalizedFind !== find ? replace.replace(/\n/g, '\r\n') : replace
  const after = before.slice(0, first) + normalizedReplace + before.slice(first + normalizedFind.length)
  if (Buffer.byteLength(after) > MAX_WRITE_BYTES) throw new ToolError('Resulting file is too large.')
  return { absolute: target.absolute, relative: target.relative, before, after }
}
