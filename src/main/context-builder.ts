import type { AutonomyMode, ProjectSummary, TaskNote } from '../shared/contracts'
import { describeMode } from './permission-engine'
import { readProjectFile } from './project-tools'
import { redactSecrets } from './redaction'

/**
 * Builds the context the local model sees, so the developer never has to paste
 * screenshots, file trees or previous steps again. Budgeted for small local models
 * (8 GB RAM machines): roughly 14k characters of context by default.
 */

export const DEFAULT_CONTEXT_BUDGET = 14_000
const KEY_FILES = ['package.json', 'README.md', 'readme.md', 'tsconfig.json', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts']
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'kya', 'hai', 'kar', 'karo', 'mein', 'mera', 'meri', 'mujhe', 'muje', 'kaise', 'file', 'code', 'please', 'how', 'what', 'why', 'from', 'into', 'ko', 'ka', 'ki', 'ke', 'se', 'me', 'ye', 'vo', 'aur', 'bhi', 'nahi', 'ni'])

export function extractKeywords(message: string): string[] {
  return [...new Set(
    message
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  )].slice(0, 12)
}

/** Pick files whose path mentions what the user is asking about. */
export function rankRelevantFiles(project: ProjectSummary, message: string, limit = 3): string[] {
  const keywords = extractKeywords(message)
  if (!keywords.length) return []
  const scored = project.files
    .filter((file) => file.kind === 'file')
    .map((file) => {
      const target = file.relativePath.toLowerCase()
      const base = file.name.toLowerCase()
      let score = 0
      for (const keyword of keywords) {
        if (base.startsWith(keyword) || base.replace(/\.[^.]+$/, '') === keyword) score += 3
        else if (base.includes(keyword)) score += 2
        else if (target.includes(keyword)) score += 1
      }
      return { path: file.relativePath, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((entry) => entry.path)
}

function compactTree(project: ProjectSummary, maxLines = 120): string {
  const lines = project.files.slice(0, maxLines).map((file) => `${file.kind === 'directory' ? '📁' : '  '} ${file.relativePath}`)
  if (project.files.length > maxLines) lines.push(`… ${project.files.length - maxLines} more entries (use list_files)`)
  return lines.join('\n')
}

export type BuiltContext = { systemPrompt: string; includedFiles: string[] }

export async function buildContext(options: {
  project: ProjectSummary | null
  notes: TaskNote[]
  mode: AutonomyMode
  userMessage: string
  toolsEnabled: boolean
  toolNames?: string[]
  budget?: number
}): Promise<BuiltContext> {
  const { project, notes, mode, userMessage, toolsEnabled } = options
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET
  const parts: string[] = [
    'You are Dev Companion, a local AI developer companion running on the developer\'s own Windows PC.',
    'Answer in the same language the developer uses (Hinglish if they write Hinglish). Be concise, concrete and step-by-step.',
    'Never ask for, repeat or invent passwords, API keys, tokens or OTPs. If a step needs a secret, tell the developer to enter it themselves.',
    'Values shown as [REDACTED] are secrets that were removed on purpose — do not try to reconstruct them.',
    describeMode(mode),
  ]
  if (toolsEnabled) {
    const names = options.toolNames?.length ? options.toolNames : ['list_files', 'read_file', 'search_code']
    parts.push(
      `Tools available: ${names.join(', ')}. Use them instead of guessing about the codebase. Paths are relative to the project root.`,
      'Before editing a file, read it first. Make small, focused edits with edit_file. After changing code, run the relevant test/typecheck script if one exists.',
      'Some actions pause for the developer\'s approval; if one is rejected, do not retry it — ask what they want instead.',
    )
  }

  const includedFiles: string[] = []
  if (!project) {
    parts.push('No project is selected yet. If the question is about a codebase, ask the developer to select the project folder in the app.')
    return { systemPrompt: parts.join('\n'), includedFiles }
  }

  parts.push(
    '',
    `## Active project: ${project.name}`,
    `Stack: ${project.detectedStack.join(', ') || 'not detected'}`,
    `Package manager: ${project.packageManager ?? 'unknown'}`,
    `Scripts: ${project.scripts.join(', ') || 'none'}`,
    `Files scanned: ${project.fileCount}${project.truncated ? ' (tree capped)' : ''}`,
  )

  const openNotes = notes.filter((note) => note.projectPath === project.path && !note.completed).slice(0, 10)
  if (openNotes.length) {
    parts.push('', '## Developer\'s pending tasks', ...openNotes.map((note) => `- ${redactSecrets(note.text)}`))
  }

  parts.push('', '## File tree', compactTree(project))

  let used = parts.join('\n').length
  const available = new Set(project.files.filter((file) => file.kind === 'file').map((file) => file.relativePath))
  const wanted = [...KEY_FILES.filter((file) => available.has(file)).slice(0, 2), ...rankRelevantFiles(project, userMessage)]
  for (const relativePath of [...new Set(wanted)]) {
    const remaining = budget - used
    if (remaining < 600) break
    try {
      const content = await readProjectFile(project.path, relativePath)
      const slice = content.length > Math.min(remaining, 5_000) ? `${content.slice(0, Math.min(remaining, 5_000))}\n… (truncated, use read_file for more)` : content
      parts.push('', '```', slice, '```')
      includedFiles.push(relativePath)
      used += slice.length + 10
    } catch {
      // Protected or unreadable files are silently skipped.
    }
  }

  return { systemPrompt: parts.join('\n'), includedFiles }
}
