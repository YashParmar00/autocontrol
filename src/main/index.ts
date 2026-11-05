import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { inspectProject } from './project-service'
import { checkOllama } from './ollama-service'
import { redactSecrets } from './redaction'
import { runAgent } from './agent'
import { ApprovalBroker } from './approvals'
import { applyPlannedWrite, undoCheckpoint } from './file-ops'
import { ProcessManager, SCRIPT_NAME } from './process-manager'
import { isAutonomyMode } from './permission-engine'
import {
  addAuditEntry, addChatMessage, addTaskNote, clearChatHistory, getAssistantSettings, getAuditLog,
  getChatHistory, getStoreSnapshot, listCheckpoints, setActiveProject, toggleTaskNote, updateAssistantSettings,
} from './store'
import type { AppInfo, ChatStreamEvent, DashboardSnapshot, ProjectSummary } from '../shared/contracts'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let mainWindow: BrowserWindow | null = null
/** Every running AI request, so the emergency stop can abort all of them at once. */
const runningRequests = new Map<string, AbortController>()

function emitChat(event: ChatStreamEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:event', event)
}

const processes = new ProcessManager()
const approvals = new ApprovalBroker((approval) => emitChat({ requestId: approval.requestId, type: 'approval', approval }))

async function activeProjectOrThrow(): Promise<ProjectSummary> {
  const stored = await getStoreSnapshot()
  if (!stored.activeProject) throw new Error('Pehle project folder select karo.')
  return stored.activeProject
}

function getAppInfo(): AppInfo {
  return { name: app.getName(), version: app.getVersion(), platform: process.platform }
}

function trustedRendererUrl(): string {
  if (isDev) return process.env.ELECTRON_RENDERER_URL ?? ''
  return pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
}

function isTrustedRendererUrl(candidate: string): boolean {
  const expected = trustedRendererUrl()
  if (!expected || !candidate) return false
  if (!isDev) return candidate === expected
  try {
    const actualUrl = new URL(candidate)
    const expectedUrl = new URL(expected)
    return actualUrl.origin === expectedUrl.origin && actualUrl.pathname === expectedUrl.pathname
  } catch {
    return false
  }
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? ''
  const isMainFrame = Boolean(event.senderFrame) && event.senderFrame === event.sender.mainFrame
  const allowed = isMainFrame && isTrustedRendererUrl(frameUrl)
  if (!allowed || !mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Blocked IPC request from an untrusted renderer.')
  }
}

function registerIpc(): void {
  ipcMain.handle('app:get-info', (event) => {
    assertTrustedSender(event)
    return getAppInfo()
  })

  ipcMain.handle('dashboard:get', async (event): Promise<DashboardSnapshot> => {
    assertTrustedSender(event)
    const stored = await getStoreSnapshot()
    return { app: getAppInfo(), activeProject: stored.activeProject, notes: stored.notes }
  })

  ipcMain.handle('project:select', async (event): Promise<ProjectSummary | null> => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select a development project',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const project = await inspectProject(result.filePaths[0])
    await setActiveProject(project)
    return project
  })

  ipcMain.handle('project:refresh', async (event): Promise<ProjectSummary | null> => {
    assertTrustedSender(event)
    const stored = await getStoreSnapshot()
    if (!stored.activeProject?.path) return null
    const project = await inspectProject(stored.activeProject.path)
    await setActiveProject(project)
    return project
  })

  ipcMain.handle('task:add', async (event, rawText: unknown) => {
    assertTrustedSender(event)
    const text = redactSecrets(z.string().trim().min(2).max(500).parse(rawText))
    const stored = await getStoreSnapshot()
    if (!stored.activeProject) throw new Error('Select a project before adding a task note.')
    return addTaskNote(stored.activeProject.path, text)
  })

  ipcMain.handle('task:toggle', async (event, rawId: unknown) => {
    assertTrustedSender(event)
    const id = z.string().uuid().parse(rawId)
    return toggleTaskNote(id)
  })

  ipcMain.handle('ollama:check', async (event) => {
    assertTrustedSender(event)
    return checkOllama()
  })

  ipcMain.handle('assistant:get-settings', async (event) => {
    assertTrustedSender(event)
    return getAssistantSettings()
  })

  ipcMain.handle('assistant:update-settings', async (event, rawPatch: unknown) => {
    assertTrustedSender(event)
    const patch = z.object({
      model: z.string().trim().min(1).max(200).regex(/^[\w.:/-]+$/).nullable().optional(),
      mode: z.string().refine(isAutonomyMode).optional(),
    }).strict().parse(rawPatch)
    const before = await getAssistantSettings()
    const after = await updateAssistantSettings({ model: patch.model, mode: isAutonomyMode(patch.mode) ? patch.mode : undefined })
    if (patch.mode && before.mode !== after.mode) {
      await addAuditEntry({ category: 'read_project', tool: 'mode_change', summary: `Mode ${before.mode} → ${after.mode}`, decision: 'allow', outcome: 'ok' })
    }
    return after
  })

  ipcMain.handle('assistant:history', async (event) => {
    assertTrustedSender(event)
    const stored = await getStoreSnapshot()
    return getChatHistory(stored.activeProject?.path ?? null)
  })

  ipcMain.handle('assistant:clear-history', async (event) => {
    assertTrustedSender(event)
    const stored = await getStoreSnapshot()
    await clearChatHistory(stored.activeProject?.path ?? null)
  })

  ipcMain.handle('assistant:audit', async (event) => {
    assertTrustedSender(event)
    return getAuditLog()
  })

  ipcMain.handle('assistant:stop-all', async (event) => {
    assertTrustedSender(event)
    const requests = runningRequests.size
    for (const controller of runningRequests.values()) controller.abort()
    runningRequests.clear()
    const rejected = approvals.rejectAll()
    const killed = processes.stopAll()
    const count = requests + rejected + killed
    if (count) await addAuditEntry({ category: 'run_command', tool: 'emergency_stop', summary: `Stopped ${requests} AI request(s), rejected ${rejected} approval(s), killed ${killed} process(es)`, decision: 'allow', outcome: 'ok' })
    return count
  })

  ipcMain.handle('assistant:send', async (event, rawText: unknown) => {
    assertTrustedSender(event)
    const text = z.string().trim().min(1).max(8_000).parse(rawText)
    const settings = await getAssistantSettings()
    if (!settings.model) throw new Error('Pehle ek local model select karo (Ollama).')
    const stored = await getStoreSnapshot()
    const projectPath = stored.activeProject?.path ?? null
    const history = await getChatHistory(projectPath, 24)
    const userMessage = await addChatMessage(projectPath, 'user', redactSecrets(text))

    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    runningRequests.set(requestId, controller)

    let wroteFiles = false
    void (async () => {
      try {
        const result = await runAgent({
          toolContext: {
            requestId,
            processes,
            requestApproval: (input) => approvals.request({ ...input, requestId }, controller.signal),
            applyWrite: async (plan, tool) => {
              if (!projectPath) throw new Error('No project selected.')
              await applyPlannedWrite(projectPath, plan, tool)
              wroteFiles = true
            },
            scriptEnv: async () => ({}),
          },
          project: stored.activeProject,
          notes: stored.notes,
          mode: settings.mode,
          model: settings.model!,
          history,
          userMessage: userMessage.content,
          signal: controller.signal,
          onToken: (token) => emitChat({ requestId, type: 'token', text: token }),
          onTool: (record) => {
            emitChat({ requestId, type: 'tool', tool: record.tool, summary: record.summary, decision: record.decision, outcome: record.outcome })
            void addAuditEntry(record)
          },
        })
        if (wroteFiles && projectPath) await setActiveProject(await inspectProject(projectPath)).catch(() => {})
        const saved = await addChatMessage(projectPath, 'assistant', result.content || '(empty answer)', result.toolTrace)
        emitChat({ requestId, type: 'done', message: saved })
      } catch (error) {
        const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        const message = aborted
          ? 'Stopped.'
          : error instanceof TypeError
            ? 'Ollama se connect nahi ho paaya. Ollama app start karo, phir retry karo.'
            : error instanceof Error ? error.message : 'AI request failed.'
        emitChat({ requestId, type: 'error', message })
      } finally {
        runningRequests.delete(requestId)
      }
    })()

    return requestId
  })

  ipcMain.handle('approval:respond', async (event, rawId: unknown, rawApproved: unknown) => {
    assertTrustedSender(event)
    return approvals.respond(z.string().uuid().parse(rawId), z.boolean().parse(rawApproved))
  })

  ipcMain.handle('checkpoints:list', async (event) => {
    assertTrustedSender(event)
    const stored = await getStoreSnapshot()
    return listCheckpoints(stored.activeProject?.path ?? null)
  })

  ipcMain.handle('checkpoints:undo', async (event, rawId: unknown) => {
    assertTrustedSender(event)
    const project = await activeProjectOrThrow()
    const id = z.string().uuid().parse(rawId)
    await undoCheckpoint(project.path, id)
    await addAuditEntry({ category: 'edit_code', tool: 'undo', summary: `Undo checkpoint ${id.slice(0, 8)}`, decision: 'allow', outcome: 'ok' })
    await setActiveProject(await inspectProject(project.path)).catch(() => {})
    return listCheckpoints(project.path)
  })

  ipcMain.handle('process:list', (event) => {
    assertTrustedSender(event)
    return processes.list()
  })

  ipcMain.handle('process:read', (event, rawId: unknown) => {
    assertTrustedSender(event)
    return processes.read(z.string().min(1).max(40).parse(rawId), 40_000)
  })

  ipcMain.handle('process:start', async (event, rawScript: unknown) => {
    assertTrustedSender(event)
    // Started by the developer's own click, so no approval prompt — but still only package.json scripts.
    const project = await activeProjectOrThrow()
    const script = z.string().regex(SCRIPT_NAME).parse(rawScript)
    if (!project.scripts.includes(script)) throw new Error(`"${script}" is not a script in package.json.`)
    const info = processes.start({ cwd: project.path, manager: project.packageManager, script })
    await addAuditEntry({ category: 'run_command', tool: 'start_process (you)', summary: `${script} → ${info.id}`, decision: 'allow', outcome: 'ok' })
    return info
  })

  ipcMain.handle('process:stop', (event, rawId: unknown) => {
    assertTrustedSender(event)
    return processes.stop(z.string().min(1).max(40).parse(rawId))
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#f6f7f9',
    title: 'Dev Companion',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  app.setAppUserModelId('in.devcompanion.desktop')
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => { processes.stopAll() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
