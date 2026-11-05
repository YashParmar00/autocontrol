import { contextBridge, ipcRenderer } from 'electron'
import type { DevCompanionApi } from '../shared/contracts'

const api: DevCompanionApi = {
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  selectProject: () => ipcRenderer.invoke('project:select'),
  refreshProject: () => ipcRenderer.invoke('project:refresh'),
  addTaskNote: (text) => ipcRenderer.invoke('task:add', text),
  toggleTaskNote: (id) => ipcRenderer.invoke('task:toggle', id),
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
}

contextBridge.exposeInMainWorld('devCompanion', api)
