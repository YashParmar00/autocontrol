import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { inspectProject } from './project-service'
import { addTaskNote, getStoreSnapshot, setActiveProject, toggleTaskNote } from './store'
import { checkOllama } from './ollama-service'
import { redactSecrets } from './redaction'
import type { AppInfo, DashboardSnapshot, ProjectSummary } from '../shared/contracts'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let mainWindow: BrowserWindow | null = null

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
  const allowed = Boolean(event.senderFrame?.isMainFrame) && isTrustedRendererUrl(frameUrl)
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
