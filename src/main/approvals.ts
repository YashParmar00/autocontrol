import type { ActionCategory, ApprovalRequest } from '../shared/contracts'

/**
 * Holds actions that need a human "yes". The agent awaits `request()`; the UI answers
 * through `respond()`. Unanswered requests expire (treated as "no").
 */
export class ApprovalBroker {
  private pending = new Map<string, { request: ApprovalRequest; resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>()

  constructor(private emit: (request: ApprovalRequest) => void, private timeoutMs = 5 * 60_000) {}

  request(input: { requestId: string; tool: string; category: ActionCategory; summary: string; preview: string }, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    const request: ApprovalRequest = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input }
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        const entry = this.pending.get(request.id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(request.id)
        signal?.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), this.timeoutMs)
      this.pending.set(request.id, { request, resolve: finish, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.emit(request)
    })
  }

  respond(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    entry.resolve(approved)
    return true
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  rejectAll(): number {
    const ids = [...this.pending.keys()]
    ids.forEach((id) => this.respond(id, false))
    return ids.length
  }
}
