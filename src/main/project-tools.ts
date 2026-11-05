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
