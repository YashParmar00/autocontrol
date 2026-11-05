import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Activity, ArrowUpRight, BrainCircuit, Check, CheckCircle2,
  ChevronDown, Circle, Code2, Command, Folder, FolderOpen, GitBranch,
  HardDrive, ListTodo, LoaderCircle, Monitor, Plus, RefreshCw,
  ShieldCheck, Sparkles, Wifi, WifiOff, X,
} from 'lucide-react'
import type { DashboardSnapshot, OllamaStatus, TaskNote } from '../../shared/contracts'
import { AssistantView } from './AssistantView'
import { ActivityView } from './ActivityView'

type View = 'overview' | 'assistant' | 'activity'
const VIEW_TITLES: Record<View, string> = { overview: 'Overview', assistant: 'Assistant', activity: 'Security & activity' }

const EMPTY_DASHBOARD: DashboardSnapshot = {
  app: { name: 'Dev Companion', version: '0.2.0', platform: 'win32' },
  activeProject: null,
  notes: [],
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(EMPTY_DASHBOARD)
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [error, setError] = useState('')
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [view, setView] = useState<View>('overview')

  const project = dashboard.activeProject
  const notes = useMemo(() => dashboard.notes.filter((note) => !project || note.projectPath === project.path), [dashboard.notes, project])
  const pendingCount = notes.filter((note) => !note.completed).length
  const visibleFiles = project?.files.slice(0, showAllFiles ? 100 : 14) ?? []

  async function loadDashboard() {
    try {
      const result = await window.devCompanion.getDashboard()
      setDashboard(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load local workspace memory.')
    } finally {
      setLoading(false)
    }
  }

  async function refreshOllama() {
    try { setOllama(await window.devCompanion.checkOllama()) }
    catch { setOllama({ connected: false, baseUrl: 'http://127.0.0.1:11434', models: [], message: 'Could not check local AI runtime.' }) }
  }

  useEffect(() => {
    void loadDashboard()
    void refreshOllama()
  }, [])

  async function selectProject() {
    setBusy(true)
    setError('')
    try {
      const selected = await window.devCompanion.selectProject()
      if (selected) setDashboard((current) => ({ ...current, activeProject: selected }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect the selected project.')
    } finally { setBusy(false) }
  }

  async function refreshProject() {
    if (!project) return
    setBusy(true)
    setError('')
    try {
      const updated = await window.devCompanion.refreshProject()
      if (updated) setDashboard((current) => ({ ...current, activeProject: updated }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project refresh failed.')
    } finally { setBusy(false) }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault()
    if (!noteText.trim()) return
    setError('')
    try {
      const note = await window.devCompanion.addTaskNote(noteText.trim())
      setDashboard((current) => ({ ...current, notes: [note, ...current.notes] }))
      setNoteText('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the task note.') }
  }

  async function toggleNote(note: TaskNote) {
    try {
      const updated = await window.devCompanion.toggleTaskNote(note.id)
      setDashboard((current) => ({ ...current, notes: updated }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the task note.')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><BrainCircuit size={20} /></div>
          <div><div className="brand-name">dev companion</div><div className="brand-caption">LOCAL DEVELOPER ASSISTANT</div></div>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-avatar">YP</div>
          <div className="workspace-copy"><strong>Personal workspace</strong><span>Local on this device</span></div>
          <ChevronDown size={15} className="muted-icon" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list">
          <button className={`nav-item ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}><Activity size={17} /><span>Overview</span>{pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}</button>
          <button className={`nav-item ${view === 'assistant' ? 'active' : ''}`} onClick={() => setView('assistant')}><Sparkles size={17} /><span>Assistant</span><span className="coming-soon live">NEW</span></button>
        </nav>
        <div className="nav-label tools-label">SYSTEM</div>
        <nav className="nav-list">
          <button className={`nav-item ${view === 'activity' ? 'active' : ''}`} onClick={() => setView('activity')}><ShieldCheck size={17} /><span>Security & activity</span></button>
          <div className="nav-item nav-planned"><Monitor size={17} /><span>Screen awareness</span><span className="coming-soon">NEXT</span></div>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card"><div className="privacy-icon"><ShieldCheck size={16} /></div><div><strong>Local-first by design</strong><span>Project context stays on this device.</span></div></div>
          <div className="profile-row"><div className="profile-avatar">Y</div><div className="profile-copy"><strong>Developer</strong><span>Windows desktop</span></div><Command size={16} className="muted-icon" /></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="slash">/</span><strong>{VIEW_TITLES[view]}</strong></div>
          <div className="topbar-right"><span className="local-pill"><span className="green-dot" /> LOCAL SESSION</span><span className="topbar-divider" /><div className="version-label">v{dashboard.app.version}</div></div>
        </header>

        {view === 'assistant' && <div className="page-content assistant-page"><AssistantView project={project} ollama={ollama} onRefreshOllama={() => void refreshOllama()} /></div>}
        {view === 'activity' && <div className="page-content"><ActivityView /></div>}
        <div className="page-content" hidden={view !== 'overview'}>
          <section className="welcome-row">
            <div><div className="eyebrow">YOUR DEVELOPMENT WORKSPACE</div><h1>Good to have you here.</h1><p>Keep building. I’ll keep the project context close.</p></div>
            <button className="secondary-button" onClick={refreshProject} disabled={!project || busy}><RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh context</button>
          </section>

          {error && <div className="error-banner"><X size={16} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}

          <section className="hero-card">
            <div className="hero-main"><div className="hero-icon"><BrainCircuit size={22} /></div><div><div className="hero-kicker">ASSISTANT STATUS <span className="status-dot" /></div><h2>{ollama?.connected ? 'Local AI brain is online' : 'Project context is ready — start Ollama for AI'}</h2><p>Assistant project files khud padhta hai (secrets ke bina). Screen observation aur actions agle milestone mein.</p><button className="hero-cta" onClick={() => setView('assistant')}>Open assistant <ArrowUpRight size={13} /></button></div></div>
            <div className="hero-side"><div className="mode-label">CURRENT MODE</div><div className="mode-value"><span className="mode-dot" /> Read-only AI tools</div><div className="mode-footnote">Every action is permission-checked</div></div>
          </section>

          <section className="section-heading"><div><h2>Workspace overview</h2><p>Your local project and runtime at a glance.</p></div><span className="updated-label">{loading ? 'Loading workspace…' : 'Updated just now'}</span></section>
          <section className="metrics-grid">
            <article className="metric-card"><div className="metric-top"><span>ACTIVE PROJECT</span><FolderOpen size={16} /></div><div className="metric-value project-metric">{project ? project.name : 'No project yet'}</div><div className="metric-foot">{project ? `${project.fileCount} files scanned` : 'Choose a folder to get started'}</div></article>
            <article className="metric-card"><div className="metric-top"><span>DETECTED STACK</span><Code2 size={16} /></div><div className="metric-value">{project?.detectedStack.length ? project.detectedStack.length : '—'}</div><div className="metric-foot">{project?.detectedStack.join(' · ') || 'Waiting for project scan'}</div></article>
            <article className="metric-card"><div className="metric-top"><span>PENDING TASKS</span><ListTodo size={16} /></div><div className="metric-value">{project ? pendingCount : '—'}</div><div className="metric-foot">{project ? `${notes.length} notes in project memory` : 'Select a project first'}</div></article>
            <article className="metric-card"><div className="metric-top"><span>LOCAL AI RUNTIME</span>{ollama?.connected ? <Wifi size={16} /> : <WifiOff size={16} />}</div><div className={`metric-value runtime-value ${ollama?.connected ? 'connected' : ''}`}>{ollama ? (ollama.connected ? 'Connected' : 'Offline') : 'Checking…'}</div><div className="metric-foot">{ollama?.models.length ? `${ollama.models.length} model${ollama.models.length === 1 ? '' : 's'} available` : 'Ollama · 127.0.0.1:11434'}</div></article>
          </section>

          <section className="content-grid">
            <article className="panel project-panel">
              <div className="panel-header"><div><h3>Project context</h3><p>Map project structure and key stack metadata.</p></div><div className="panel-icon"><Folder size={17} /></div></div>
              {project ? (
                <>
                  <div className="selected-project"><div className="project-icon"><Code2 size={18} /></div><div className="selected-project-copy"><strong>{project.name}</strong><span title={project.path}>{project.path}</span></div><span className="indexed-badge"><CheckCircle2 size={12} /> Scanned</span></div>
                  <div className="stack-row"><span className="row-label">DETECTED TECHNOLOGIES</span><div className="stack-tags">{project.detectedStack.length ? project.detectedStack.map((item) => <span key={item} className="stack-tag">{item}</span>) : <span className="empty-inline">No common stack detected</span>}</div></div>
                  <div className="file-list-header"><span>PROJECT FILES</span><span>{project.fileCount} files{project.truncated ? ' · capped view' : ''}</span></div>
                  <div className="file-list">{visibleFiles.map((file) => <div className="file-row" key={file.relativePath}><span className="file-symbol">{file.kind === 'directory' ? <Folder size={14} /> : <Code2 size={14} />}</span><span>{file.relativePath}</span><span className="file-kind">{file.kind}</span></div>)}</div>
                  {project.files.length > 14 && <button className="text-button" onClick={() => setShowAllFiles(!showAllFiles)}>{showAllFiles ? 'Show fewer' : 'Show more files'} <ArrowUpRight size={13} /></button>}
                  <div className="project-meta"><span><HardDrive size={13} /> {project.packageManager ?? 'Package manager not detected'}</span><span><GitBranch size={13} /> {project.scripts.length} scripts</span></div>
                </>
              ) : (
                <div className="empty-project"><div className="empty-folder"><FolderOpen size={26} /></div><strong>No project selected</strong><p>Choose your existing project folder. I’ll inspect its structure and detect the technologies without reading secret files.</p><button className="primary-button" onClick={selectProject} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Select project folder <ArrowUpRight size={14} /></button></div>
              )}
              {project && <button className="outline-button full-width" onClick={selectProject} disabled={busy}><FolderOpen size={15} /> Switch project</button>}
            </article>

            <div className="right-column">
              <article className="panel memory-panel">
                <div className="panel-header"><div><h3>Task memory</h3><p>Notes tied to this project.</p></div><div className="panel-icon"><ListTodo size={17} /></div></div>
                {project ? <form className="note-form" onSubmit={addNote}><input value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Add a task or something to remember…" maxLength={500} /><button type="submit" disabled={!noteText.trim()} aria-label="Add task note"><Plus size={17} /></button></form> : <div className="memory-empty">Select a project to start its task memory.</div>}
                {project && <div className="notes-list">{notes.length ? notes.slice(0, 6).map((note) => <button className={`note-row ${note.completed ? 'is-complete' : ''}`} key={note.id} onClick={() => void toggleNote(note)}><span className="note-check">{note.completed ? <Check size={13} /> : <Circle size={14} />}</span><span className="note-copy"><strong>{note.text}</strong><small>{formatDate(note.createdAt)}</small></span></button>) : <div className="memory-empty">No notes yet. Add your current goal or next step above.</div>}</div>}
                {notes.length > 6 && <div className="notes-more">Showing 6 of {notes.length} notes</div>}
              </article>

              <article className="panel runtime-panel">
                <div className="panel-header"><div><h3>Local AI runtime</h3><p>Ollama connection check.</p></div><div className={`runtime-icon ${ollama?.connected ? 'ok' : ''}`}><Sparkles size={17} /></div></div>
                <div className="runtime-status"><span className={`runtime-status-dot ${ollama?.connected ? 'online' : ''}`} /><div><strong>{ollama?.connected ? 'Ollama is reachable' : 'Ollama is not connected'}</strong><span>{ollama?.message ?? 'Checking local endpoint…'}</span></div></div>
                {ollama?.models?.length ? <div className="model-list">{ollama.models.slice(0, 3).map((model) => <span key={model}>{model}</span>)}{ollama.models.length > 3 && <span>+{ollama.models.length - 3} more</span>}</div> : null}
                <button className="text-button runtime-refresh" onClick={refreshOllama}><RefreshCw size={13} /> Check again</button>
                {!ollama?.connected && <div className="runtime-help">Start the Ollama app, then check again. No cloud AI calls are made by this check.</div>}
              </article>

              <article className="safety-panel"><div className="safety-title"><ShieldCheck size={16} /><strong>Safety boundaries are on</strong></div><p>Secrets project scan aur AI context dono se bahar hain. AI abhi sirf files padh sakta hai — click, type, form submit ya shell commands nahi.</p><div className="safety-footer"><span><CheckCircle2 size={13} /> Local project scan</span><span><CheckCircle2 size={13} /> Human-controlled</span></div></article>
            </div>
          </section>
          <footer className="page-footer"><span>DEV COMPANION · LOCAL-FIRST DEVELOPMENT ASSISTANT</span><span><Monitor size={12} /> Running on this device</span></footer>
        </div>
      </main>
    </div>
  )
}

export default App
