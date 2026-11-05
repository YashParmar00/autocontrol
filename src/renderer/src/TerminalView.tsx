import { useEffect, useRef, useState } from 'react'
import { Play, Square, TerminalSquare } from 'lucide-react'
import type { ProcessInfo, ProjectSummary } from '../../shared/contracts'

export function TerminalView({ project }: { project: ProjectSummary | null }) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const outputRef = useRef<HTMLPreElement>(null)

  async function refresh() {
    const list = await window.devCompanion.listProcesses()
    setProcesses(list)
    const current = selected ?? list[0]?.id ?? null
    if (current !== selected) setSelected(current)
    if (current) {
      try { setOutput(await window.devCompanion.readProcess(current)) } catch { setOutput('') }
    } else setOutput('')
  }

  // Poll while the view is open; output buffers live in the main process.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 1_500)
    return () => clearInterval(timer)
  }, [selected])

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
  }, [output])

  async function start(script: string) {
    setError('')
    try {
      const info = await window.devCompanion.startScript(script)
      setSelected(info.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not start.')
    }
  }

  return (
    <div className="terminal-view">
      <div className="terminal-side">
        <article className="panel">
          <div className="panel-header"><div><h3>Scripts</h3><p>{project ? 'Click karke background mein chalao. AI bhi inka output padh sakta hai.' : 'Pehle project select karo.'}</p></div><div className="panel-icon"><TerminalSquare size={17} /></div></div>
          <div className="script-list">
            {project?.scripts.map((script) => <button key={script} className="script-chip" onClick={() => void start(script)}><Play size={10} /> {script}</button>)}
          </div>
          {error && <div className="error-banner compact"><span>{error}</span></div>}
        </article>
        <article className="panel">
          <div className="panel-header"><div><h3>Processes</h3><p>App ke start kiye hue (AI ya aap).</p></div></div>
          {processes.length ? processes.map((proc) => (
            <button key={proc.id} className={`process-row ${proc.id === selected ? 'selected' : ''}`} onClick={() => setSelected(proc.id)}>
              <span className={`dot ${proc.running ? 'on' : ''}`} /> {proc.label}
              <span className="meta">{proc.running ? proc.id : `exit ${proc.exitCode}`}</span>
            </button>
          )) : <div className="memory-empty">Kuch nahi chal raha.</div>}
        </article>
      </div>
      <div className="terminal-main">
        <div className="assistant-toolbar" style={{ marginBottom: 10 }}>
          <strong style={{ fontSize: 12 }}>{processes.find((proc) => proc.id === selected)?.label ?? 'Output'}</strong>
          {selected && processes.find((proc) => proc.id === selected)?.running && (
            <button className="stop-button" onClick={() => void window.devCompanion.stopProcess(selected)}><Square size={12} /> Stop</button>
          )}
        </div>
        <pre className="terminal-output" ref={outputRef} style={{ height: 'calc(100% - 46px)' }}>{output || 'Output yahan dikhega. Secrets automatically [REDACTED] hote hain.'}</pre>
      </div>
    </div>
  )
}
