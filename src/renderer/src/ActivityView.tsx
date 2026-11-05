import { useEffect, useState } from 'react'
import { History, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import type { AuditEntry, CheckpointEntry } from '../../shared/contracts'

const POLICY_ROWS: Array<[string, string, string, string]> = [
  ['Project files padhna', 'Allow', 'Allow', 'Allow'],
  ['Code edit / tests', 'Deny', 'Ask', 'Allow'],
  ['Commands, installs, DB, forms, emails, deploy', 'Deny', 'Ask', 'Ask'],
  ['Payments / purchases', 'Never', 'Never', 'Never'],
]

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

export function ActivityView() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [audit, saved] = await Promise.all([window.devCompanion.getAuditLog(), window.devCompanion.getCheckpoints()])
      setEntries(audit)
      setCheckpoints(saved)
    } finally { setLoading(false) }
  }

  async function undo(id: string) {
    setError('')
    try {
      setCheckpoints(await window.devCompanion.undoCheckpoint(id))
      setEntries(await window.devCompanion.getAuditLog())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Undo failed.')
    }
  }

  useEffect(() => { void load() }, [])

  return (
    <div className="activity-view">
      <article className="panel">
        <div className="panel-header"><div><h3>Permission policy</h3><p>Har AI action is table se check hota hai. Unknown action = deny.</p></div><div className="panel-icon"><ShieldCheck size={17} /></div></div>
        <table className="policy-table">
          <thead><tr><th>Action</th><th>Guide</th><th>Supervised</th><th>Autonomous</th></tr></thead>
          <tbody>{POLICY_ROWS.map(([action, ...cells]) => (
            <tr key={action}><td>{action}</td>{cells.map((cell, index) => <td key={index}><span className={`policy-pill ${cell.toLowerCase()}`}>{cell}</span></td>)}</tr>
          ))}</tbody>
        </table>
      </article>

      <article className="panel">
        <div className="panel-header"><div><h3>AI file changes</h3><p>Har AI edit se pehle checkpoint banta hai. Undo = file wapas pehle jaisi (naya file ho to delete).</p></div><div className="panel-icon"><History size={17} /></div></div>
        {error && <div className="error-banner compact"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {checkpoints.length ? checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className="checkpoint-row">
            <code>{checkpoint.file}{checkpoint.created ? ' (new)' : ''}</code>
            <span className="audit-meta">{checkpoint.tool} · {formatTime(checkpoint.at)}</span>
            {checkpoint.restored
              ? <span className="policy-pill">undone</span>
              : <button className="outline-button" onClick={() => void undo(checkpoint.id)}><RotateCcw size={12} /> Undo</button>}
          </div>
        )) : <div className="memory-empty">Is project mein AI ne abhi tak koi file change nahi ki.</div>}
      </article>

      <article className="panel">
        <div className="panel-header"><div><h3>Audit log</h3><p>AI ne kya access kiya — sab yahan record hota hai.</p></div><button className="outline-button" onClick={() => void load()}><RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh</button></div>
        {entries.length ? (
          <div className="audit-list">
            {entries.map((entry) => (
              <div key={entry.id} className="audit-row">
                <span className={`policy-pill ${entry.outcome === 'ok' ? 'allow' : entry.outcome === 'blocked' ? 'deny' : 'ask'}`}>{entry.outcome}</span>
                <code>{entry.summary}</code>
                <span className="audit-meta">{entry.category} · {formatTime(entry.at)}</span>
              </div>
            ))}
          </div>
        ) : <div className="memory-empty">Abhi tak koi AI action nahi hua.</div>}
      </article>
    </div>
  )
}
