import { useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import type { AuditEntry } from '../../shared/contracts'

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
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try { setEntries(await window.devCompanion.getAuditLog()) } finally { setLoading(false) }
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
