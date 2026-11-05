import { useEffect, useState } from 'react'
import type { OllamaStatus, ProjectSummary } from '../../shared/contracts'
import { AssistantView } from './AssistantView'

/** Floating always-on-top window: just the assistant for the active project. */
export function MiniApp() {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)

  async function refreshOllama() {
    try { setOllama(await window.devCompanion.checkOllama()) } catch { /* shown in main window */ }
  }

  useEffect(() => {
    void window.devCompanion.getDashboard().then((dashboard) => setProject(dashboard.activeProject))
    void refreshOllama()
  }, [])

  return (
    <div className="mini-shell">
      <div className="mini-title">{project ? project.name : 'No project'} · Ctrl+Shift+Space</div>
      <AssistantView project={project} ollama={ollama} onRefreshOllama={() => void refreshOllama()} compact />
    </div>
  )
}
