import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { inspectProject } from './project-service'
import { checkOllama } from './ollama-service'
import { redactSecrets } from './redaction'
import { runAgent } from './agent'
import { isAutonomyMode } from './permission-engine'
import {
  addAuditEntry, addChatMessage, addTaskNote, clearChatHistory, getAssistantSettings, getAuditLog,
  getChatHistory, getStoreSnapshot, setActiveProject, toggleTaskNote, updateAssistantSettings,
} from './store'
import type { AppInfo, ChatStreamEvent, DashboardSnapshot, ProjectSummary } from '../shared/contracts'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let mainWindow: BrowserWindow | null = null
/** Every running AI request, so the emergency stop can abort all of them at once. */
const runningRequests = new Map<string, AbortController>()

function emitChat(event: ChatStreamEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:event', event)
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
    const count = runningRequests.size
    for (const controller of runningRequests.values()) controller.abort()
    runningRequests.clear()
    if (count) await addAuditEntry({ category: 'read_project', tool: 'emergency_stop', summary: `Stopped ${count} running request(s)`, decision: 'allow', outcome: 'ok' })
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

    void (async () => {
      try {
        const result = await runAgent({
          project: stored.activeProject,
          notes: stored.notes,
          mode: settings.mode,
          model: settings.model!,
          history,
          userMessage: userMessage.content,
          signal: controller.signal,
          onToken: (token) => emitChat({ requestId, type: 'token', text: token }),
          onTool: (record) => {
            emitChat({ requestId, type: 'tool', tool: record.tool, summary: record.summary, decision: record.decision })
            void addAuditEntry(record)
          },
        })
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
