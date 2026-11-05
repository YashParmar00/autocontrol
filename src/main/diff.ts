/**
 * Small line-based diff (LCS) used for approval previews. Bounded so a huge file
 * can never freeze the main process: above the limit we fall back to a summary.
 */

const MAX_CELLS = 4_000_000
const CONTEXT = 3

export type DiffLine = { kind: ' ' | '+' | '-'; text: string }

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before === '' ? [] : before.split(/\r?\n/)
  const b = after === '' ? [] : after.split(/\r?\n/)
  // Trim common prefix/suffix first — most edits are local.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > MAX_CELLS) return null

  const rows = midA.length + 1
  const cols = midB.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * cols + j] = midA[i] === midB[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { middle.push({ kind: ' ', text: midA[i] }); i++; j++ }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { middle.push({ kind: '-', text: midA[i++] }) }
    else { middle.push({ kind: '+', text: midB[j++] }) }
  }
  while (i < midA.length) middle.push({ kind: '-', text: midA[i++] })
  while (j < midB.length) middle.push({ kind: '+', text: midB[j++] })

  return [
    ...a.slice(0, start).map((text) => ({ kind: ' ' as const, text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ kind: ' ' as const, text })),
  ]
}

/** Render a compact unified-style preview with a few lines of context around changes. */
export function renderDiff(path: string, before: string | null, after: string, maxLines = 160): string {
  const header = before === null ? `+++ new file: ${path}` : `--- ${path}\n+++ ${path}`
  const lines = diffLines(before ?? '', after)
  if (!lines) {
    const beforeCount = (before ?? '').split('\n').length
    return `${header}\n(large change: ${beforeCount} → ${after.split('\n').length} lines; preview skipped)`
  }
  const changed = lines.map((line, index) => (line.kind !== ' ' ? index : -1)).filter((index) => index >= 0)
  if (!changed.length) return `${header}\n(no changes)`
  const keep = new Set<number>()
  for (const index of changed) {
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) keep.add(k)
  }
  const out: string[] = [header]
  let previous = -1
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (previous >= 0 && index !== previous + 1) out.push('@@ … @@')
    const line = lines[index]
    out.push(`${line.kind}${line.text}`)
    previous = index
  }
  const totalAdded = lines.filter((line) => line.kind === '+').length
  const totalRemoved = lines.filter((line) => line.kind === '-').length
  if (out.length > maxLines + 1) {
    return [...out.slice(0, maxLines + 1), `… preview truncated (+${totalAdded} −${totalRemoved} lines total)`].join('\n')
  }
  return [...out, `(+${totalAdded} −${totalRemoved})`].join('\n')
}
