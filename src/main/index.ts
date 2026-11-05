import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { inspectProject } from './project-service'
import { checkOllama } from './ollama-service'
import { redactSecrets, setKnownSecrets } from './redaction'
import { defaultTools, runAgent, type AgentTool } from './agent'
import { BrowserBridge, createPairingToken, describeTab, type BrowserTabContext } from './browser-bridge'
import { browserTools, screenTools } from './capability-tools'
import { describeImage } from './ollama-chat'
import { captureScreen } from './screen'
import { Vault, VAULT_NAME } from './vault'
import { ApprovalBroker } from './approvals'
import { applyPlannedWrite, undoCheckpoint } from './file-ops'
import { ProcessManager, SCRIPT_NAME } from './process-manager'
import { isAutonomyMode } from './permission-engine'
import {
  addAuditEntry, addChatMessage, addTaskNote, clearChatHistory, getAssistantSettings, getAuditLog,
  getChatHistory, getLocalSetting, getStoreSnapshot, listCheckpoints, setLocalSetting, vaultStorage, setActiveProject, toggleTaskNote, updateAssistantSettings,
} from './store'
import type { AppInfo, ChatStreamEvent, DashboardSnapshot, ProjectSummary } from '../shared/contracts'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let mainWindow: BrowserWindow | null = null
let floatingWindow: BrowserWindow | null = null
const FLOATING_SHORTCUT = 'CommandOrControl+Shift+Space'

function trustedWindows(): BrowserWindow[] {
  return [mainWindow, floatingWindow].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
}
/** Every running AI request, so the emergency stop can abort all of them at once. */
const runningRequests = new Map<string, AbortController>()

function emitChat(event: ChatStreamEvent): void {
  for (const window of trustedWindows()) window.webContents.send('ai:event', event)
}

const vault = new Vault({
  // On Linux without a keyring Electron falls back to a hard-coded key ("basic_text"): treat that as unavailable.
  isAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
}, vaultStorage)

async function refreshKnownSecrets(): Promise<void> {
  setKnownSecrets(await vault.allValues())
}

async function vaultInfo() {
  return { available: vault.available(), entries: await vault.entries() }
}

const processes = new ProcessManager()
const approvals = new ApprovalBroker((approval) => emitChat({ requestId: approval.requestId, type: 'approval', approval }))

let bridgeToken = ''
const bridge = new BrowserBridge(() => bridgeToken)

async function loadBridgeToken(): Promise<void> {
  bridgeToken = (await getLocalSetting('bridge_token')) ?? ''
  if (!bridgeToken) {
    bridgeToken = createPairingToken()
    await setLocalSetting('bridge_token', bridgeToken)
  }
}

async function syncBridge(enabled: boolean): Promise<void> {
  if (enabled && !bridge.status().listening) await bridge.start()
  if (!enabled && bridge.status().listening) await bridge.close()
}

async function bridgeInfo() {
  return { ...bridge.status(), token: bridgeToken }
}

function describeScreenWith(visionModel: string, signal: AbortSignal) {
  return (imageBase64: string, question: string) => describeImage({ model: visionModel, imageBase64, question, signal })
}

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
  // The floating panel loads the same page with a #mini hash.
  const withoutHash = (value: string) => value.split('#')[0]
  if (!isDev) return withoutHash(candidate) === withoutHash(expected)
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
  if (!allowed || !trustedWindows().some((window) => window.webContents.id === event.sender.id)) {
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
    const modelName = z.string().trim().min(1).max(200).regex(/^[\w.:/-]+$/)
    const patch = z.object({
      model: modelName.nullable().optional(),
      visionModel: modelName.nullable().optional(),
      mode: z.string().refine(isAutonomyMode).optional(),
      screenEnabled: z.boolean().optional(),
      browserEnabled: z.boolean().optional(),
    }).strict().parse(rawPatch)
    const before = await getAssistantSettings()
    const after = await updateAssistantSettings({ ...patch, mode: isAutonomyMode(patch.mode) ? patch.mode : undefined })
    const changes: string[] = []
    if (before.mode !== after.mode) changes.push(`mode ${before.mode} → ${after.mode}`)
    if (before.screenEnabled !== after.screenEnabled) changes.push(`screen awareness ${after.screenEnabled ? 'ON' : 'OFF'}`)
    if (before.browserEnabled !== after.browserEnabled) changes.push(`browser bridge ${after.browserEnabled ? 'ON' : 'OFF'}`)
    if (changes.length) await addAuditEntry({ category: 'read_project', tool: 'settings', summary: changes.join(', '), decision: 'allow', outcome: 'ok' })
    await syncBridge(after.browserEnabled)
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

  ipcMain.handle('assistant:send', async (event, rawText: unknown, rawOptions: unknown) => {
    assertTrustedSender(event)
    const text = z.string().trim().min(1).max(8_000).parse(rawText)
    const options = z.object({ attachScreen: z.boolean().optional() }).strict().optional().parse(rawOptions) ?? {}
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
        const tools: AgentTool[] = defaultTools()
        let extraContext = ''
        if (settings.screenEnabled && settings.visionModel) {
          const describe = describeScreenWith(settings.visionModel, controller.signal)
          tools.push(...screenTools({ capture: () => captureScreen(), describe }))
          if (options.attachScreen) {
            emitChat({ requestId, type: 'tool', tool: 'look_at_screen', summary: 'look_at_screen (attached by you)', decision: 'allow', outcome: 'ok' })
            const description = redactSecrets(await describe(await captureScreen(), text))
            extraContext += `## What is on the developer's screen right now (described from a screenshot)\n${description}\n`
            await addAuditEntry({ category: 'analyze_screen', tool: 'look_at_screen', summary: 'Screenshot attached by developer', decision: 'allow', outcome: 'ok' })
          }
        }
        if (settings.browserEnabled && bridge.status().connected) {
          tools.push(...browserTools({
            getContext: () => bridge.request<BrowserTabContext>('get_context'),
            fill: (fields) => bridge.request('fill', { fields }),
            click: (ref) => bridge.request('click', { ref }),
            openUrl: (url) => bridge.request('open_url', { url }),
            resolveVault: (name) => vault.resolve(name),
          }))
          try {
            const tab = await bridge.request<BrowserTabContext>('get_context')
            extraContext += `## Developer's active Chrome tab (fields marked sensitive have hidden values)\n${redactSecrets(describeTab(tab, 2_500))}\n`
          } catch { /* e.g. chrome:// page */ }
        }
        const secretNames = (await vault.entries()).map((entry) => `${entry.name}${entry.env ? ' (also env var in scripts)' : ''}`)
        if (secretNames.length) {
          extraContext += `## Developer's local vault (names only — you never see values)\n${secretNames.join(', ')}\nTo type one into a browser field use the value {{vault:NAME}}. Scripts you run receive env-marked secrets as environment variables.\n`
        }
        const result = await runAgent({
          tools,
          extraContext: extraContext || undefined,
          toolContext: {
            requestId,
            processes,
            requestApproval: (input) => approvals.request({ ...input, requestId }, controller.signal),
            applyWrite: async (plan, tool) => {
              if (!projectPath) throw new Error('No project selected.')
              await applyPlannedWrite(projectPath, plan, tool)
              wroteFiles = true
            },
            scriptEnv: () => vault.scriptEnv(),
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
    const info = processes.start({ cwd: project.path, manager: project.packageManager, script, env: await vault.scriptEnv() })
    await addAuditEntry({ category: 'run_command', tool: 'start_process (you)', summary: `${script} → ${info.id}`, decision: 'allow', outcome: 'ok' })
    return info
  })

  ipcMain.handle('process:stop', (event, rawId: unknown) => {
    assertTrustedSender(event)
    return processes.stop(z.string().min(1).max(40).parse(rawId))
  })

  ipcMain.handle('bridge:info', (event) => {
    assertTrustedSender(event)
    return bridgeInfo()
  })

  ipcMain.handle('bridge:rotate', async (event) => {
    assertTrustedSender(event)
    bridgeToken = createPairingToken()
    await setLocalSetting('bridge_token', bridgeToken)
    bridge.disconnect()
    await addAuditEntry({ category: 'read_project', tool: 'bridge_token', summary: 'Pairing token rotated; extension disconnected', decision: 'allow', outcome: 'ok' })
    return bridgeInfo()
  })

  ipcMain.handle('vault:get', async (event) => {
    assertTrustedSender(event)
    return vaultInfo()
  })

  ipcMain.handle('vault:set', async (event, rawName: unknown, rawValue: unknown, rawEnv: unknown) => {
    assertTrustedSender(event)
    const name = z.string().regex(VAULT_NAME).parse(rawName)
    const value = z.string().min(1).max(8_192).parse(rawValue)
    await vault.set(name, value, z.boolean().parse(rawEnv))
    await refreshKnownSecrets()
    await addAuditEntry({ category: 'read_project', tool: 'vault', summary: `Saved secret ${name}`, decision: 'allow', outcome: 'ok' })
    return vaultInfo()
  })

  ipcMain.handle('vault:delete', async (event, rawName: unknown) => {
    assertTrustedSender(event)
    const name = z.string().regex(VAULT_NAME).parse(rawName)
    await vault.remove(name)
    await refreshKnownSecrets()
    await addAuditEntry({ category: 'read_project', tool: 'vault', summary: `Deleted secret ${name}`, decision: 'allow', outcome: 'ok' })
    return vaultInfo()
  })

  ipcMain.handle('window:toggle-floating', (event) => {
    assertTrustedSender(event)
    return toggleFloatingWindow()
  })

  ipcMain.handle('screen:preview', async (event) => {
    assertTrustedSender(event)
    const settings = await getAssistantSettings()
    if (!settings.screenEnabled) throw new Error('Screen awareness is off.')
    return `data:image/jpeg;base64,${await captureScreen(1000)}`
  })
}

function loadRenderer(window: BrowserWindow, hash = ''): void {
  if (isDev) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL!}${hash ? `#${hash}` : ''}`)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  // Keep our own windows (chat, approvals, vault) out of screenshots and screen sharing.
  window.setContentProtection(true)
}

/** Small always-on-top assistant that stays beside VS Code / Chrome. */
function toggleFloatingWindow(): boolean {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    if (floatingWindow.isVisible()) { floatingWindow.hide(); return false }
    floatingWindow.show()
    return true
  }
  floatingWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 340,
    minHeight: 420,
    alwaysOnTop: true,
    title: 'Dev Companion — mini',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  floatingWindow.setAlwaysOnTop(true, 'floating')
  hardenWindow(floatingWindow)
  loadRenderer(floatingWindow, 'mini')
  floatingWindow.on('closed', () => { floatingWindow = null })
  return true
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
  hardenWindow(mainWindow)
  loadRenderer(mainWindow)
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  app.setAppUserModelId('in.devcompanion.desktop')
  registerIpc()
  createWindow()
  void loadBridgeToken().then(async () => syncBridge((await getAssistantSettings()).browserEnabled))
  void refreshKnownSecrets()
  globalShortcut.register(FLOATING_SHORTCUT, () => { toggleFloatingWindow() })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => { processes.stopAll(); void bridge.close() })
app.on('will-quit', () => { globalShortcut.unregisterAll() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
