export type AppInfo = {
  name: string
  version: string
  platform: NodeJS.Platform
}

export type ProjectFileEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
}

export type ProjectSummary = {
  name: string
  path: string
  detectedStack: string[]
  packageManager: string | null
  scripts: string[]
  files: ProjectFileEntry[]
  fileCount: number
  truncated: boolean
  inspectedAt: string
}

export type TaskNote = {
  id: string
  projectPath: string
  text: string
  createdAt: string
  completed: boolean
}

export type DashboardSnapshot = {
  app: AppInfo
  activeProject: ProjectSummary | null
  notes: TaskNote[]
}

export type OllamaStatus = {
  connected: boolean
  baseUrl: string
  models: string[]
  message: string
}

export type DevCompanionApi = {
  getDashboard(): Promise<DashboardSnapshot>
  selectProject(): Promise<ProjectSummary | null>
  refreshProject(): Promise<ProjectSummary | null>
  addTaskNote(text: string): Promise<TaskNote>
  toggleTaskNote(id: string): Promise<TaskNote[]>
  checkOllama(): Promise<OllamaStatus>
  getAppInfo(): Promise<AppInfo>
}
