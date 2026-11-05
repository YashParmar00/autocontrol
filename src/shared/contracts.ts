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

export type DevCompanionApi = AssistantApi & {
  getDashboard(): Promise<DashboardSnapshot>
  selectProject(): Promise<ProjectSummary | null>
  refreshProject(): Promise<ProjectSummary | null>
  addTaskNote(text: string): Promise<TaskNote>
  toggleTaskNote(id: string): Promise<TaskNote[]>
  checkOllama(): Promise<OllamaStatus>
  getAppInfo(): Promise<AppInfo>
}

// ---------------------------------------------------------------------------
// v0.2.0 — AI brain, permissions, audit
// ---------------------------------------------------------------------------

/** How much the assistant may do on its own. */
export type AutonomyMode = 'guide' | 'supervised' | 'autonomous'

/** Every capability the agent can ever request is one of these categories. */
export type ActionCategory =
  | 'read_project'      // list / read / search files inside the selected project
  | 'analyze_screen'    // screen capture (planned)
  | 'read_terminal'     // read terminal output (planned)
  | 'edit_code'         // write files inside the project (planned)
  | 'run_tests'         // run a project test script (planned)
  | 'run_command'       // arbitrary shell command (planned)
  | 'install_package'   // npm/pnpm install (planned)
  | 'modify_database'   // planned
  | 'submit_form'       // browser form submit (planned)
  | 'send_message'      // email / chat (planned)
  | 'deploy_production' // planned
  | 'payment'           // purchases, transfers — always manual

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export type AuditEntry = {
  id: string
  at: string
  category: ActionCategory
  tool: string
  summary: string
  decision: PermissionDecision
  outcome: 'ok' | 'error' | 'blocked' | 'pending'
}

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  projectPath: string
  role: ChatRole
  content: string
  createdAt: string
  toolTrace?: string[]
}

export type AssistantSettings = {
  model: string | null
  mode: AutonomyMode
}

export type ApprovalRequest = {
  id: string
  requestId: string
  createdAt: string
  tool: string
  category: ActionCategory
  summary: string
  /** Diff, command line or form values the developer is approving. */
  preview: string
}

export type CheckpointEntry = {
  id: string
  at: string
  projectPath: string
  file: string
  tool: string
  created: boolean
  restored: boolean
}

export type ProcessInfo = {
  id: string
  label: string
  startedAt: string
  running: boolean
  exitCode: number | null
}

export type ChatStreamEvent =
  | { requestId: string; type: 'token'; text: string }
  | { requestId: string; type: 'approval'; approval: ApprovalRequest }
  | { requestId: string; type: 'tool'; tool: string; summary: string; decision: PermissionDecision; outcome: 'ok' | 'error' | 'blocked' }
  | { requestId: string; type: 'done'; message: ChatMessage }
  | { requestId: string; type: 'error'; message: string }

export type AssistantApi = {
  getSettings(): Promise<AssistantSettings>
  updateSettings(patch: Partial<AssistantSettings>): Promise<AssistantSettings>
  getChatHistory(): Promise<ChatMessage[]>
  clearChatHistory(): Promise<void>
  /** Starts a streamed answer; events arrive through onChatEvent. Returns the request id. */
  sendChat(text: string): Promise<string>
  /** Emergency stop: aborts every running AI request and tool call. */
  stopAll(): Promise<number>
  onChatEvent(listener: (event: ChatStreamEvent) => void): () => void
  getAuditLog(): Promise<AuditEntry[]>
  respondApproval(id: string, approved: boolean): Promise<boolean>
  getCheckpoints(): Promise<CheckpointEntry[]>
  undoCheckpoint(id: string): Promise<CheckpointEntry[]>
  listProcesses(): Promise<ProcessInfo[]>
  readProcess(id: string): Promise<string>
  startScript(script: string): Promise<ProcessInfo>
  stopProcess(id: string): Promise<boolean>
}
