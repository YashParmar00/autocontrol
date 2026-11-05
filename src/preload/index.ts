import { contextBridge, ipcRenderer } from 'electron'
import type { ChatStreamEvent, DevCompanionApi } from '../shared/contracts'

const api: DevCompanionApi = {
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  selectProject: () => ipcRenderer.invoke('project:select'),
  refreshProject: () => ipcRenderer.invoke('project:refresh'),
  addTaskNote: (text) => ipcRenderer.invoke('task:add', text),
  toggleTaskNote: (id) => ipcRenderer.invoke('task:toggle', id),
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('assistant:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('assistant:update-settings', patch),
  getChatHistory: () => ipcRenderer.invoke('assistant:history'),
  clearChatHistory: () => ipcRenderer.invoke('assistant:clear-history'),
  sendChat: (text, options) => ipcRenderer.invoke('assistant:send', text, options),
  stopAll: () => ipcRenderer.invoke('assistant:stop-all'),
  getAuditLog: () => ipcRenderer.invoke('assistant:audit'),
  respondApproval: (id, approved) => ipcRenderer.invoke('approval:respond', id, approved),
  getCheckpoints: () => ipcRenderer.invoke('checkpoints:list'),
  undoCheckpoint: (id) => ipcRenderer.invoke('checkpoints:undo', id),
  listProcesses: () => ipcRenderer.invoke('process:list'),
  readProcess: (id) => ipcRenderer.invoke('process:read', id),
  startScript: (script) => ipcRenderer.invoke('process:start', script),
  stopProcess: (id) => ipcRenderer.invoke('process:stop', id),
  getBridgeInfo: () => ipcRenderer.invoke('bridge:info'),
  rotateBridgeToken: () => ipcRenderer.invoke('bridge:rotate'),
  previewScreen: () => ipcRenderer.invoke('screen:preview'),
  onChatEvent: (listener) => {
    // Only the event payload is forwarded — never the raw IpcRendererEvent.
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent) => listener(payload)
    ipcRenderer.on('ai:event', handler)
    return () => { ipcRenderer.removeListener('ai:event', handler) }
  },
}

contextBridge.exposeInMainWorld('devCompanion', api)
