import { clickRef, extractPage, fillFields } from './page-functions.js'

const VERSION = chrome.runtime.getManifest().version
let socket = null
let retryTimer = null
let state = { connected: false, error: '' }

async function settings() {
  const { token = '', port = 47821 } = await chrome.storage.local.get(['token', 'port'])
  return { token, port: Number(port) || 47821 }
}

function setState(next) {
  state = { ...state, ...next }
  chrome.action.setBadgeText({ text: state.connected ? 'ON' : '' })
  chrome.action.setBadgeBackgroundColor({ color: state.connected ? '#2f7a4f' : '#999999' })
}

async function connect() {
  clearTimeout(retryTimer)
  const { token, port } = await settings()
  if (!token) { setState({ connected: false, error: 'Pairing token not set' }); return }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&v=${VERSION}`)
  } catch (error) {
    setState({ connected: false, error: String(error) })
    retryTimer = setTimeout(connect, 5000)
    return
  }
  socket.onopen = () => setState({ connected: true, error: '' })
  socket.onclose = () => {
    setState({ connected: false, error: state.error || 'Desktop app not reachable' })
    socket = null
    retryTimer = setTimeout(connect, 5000)
  }
  socket.onerror = () => setState({ error: 'Desktop app not reachable or token wrong' })
  socket.onmessage = async (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.type === 'ping' || !message.id) return
    try {
      const result = await handle(message)
      socket?.send(JSON.stringify({ id: message.id, ok: true, result }))
    } catch (error) {
      socket?.send(JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || !tab.id) throw new Error('No active tab')
  if (!/^https?:|^file:/.test(tab.url || '')) throw new Error(`Cannot read this kind of page (${(tab.url || '').split(':')[0]}:)`)
  return tab
}

async function run(func, args = []) {
  const tab = await activeTab()
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args })
  return injection.result
}

async function handle(message) {
  switch (message.type) {
    case 'get_context': return run(extractPage)
    case 'fill': return run(fillFields, [message.fields || []])
    case 'click': return run(clickRef, [String(message.ref || '')])
    case 'open_url': {
      const url = String(message.url || '')
      if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs can be opened')
      const tab = await chrome.tabs.create({ url, active: true })
      return { ok: true, tabId: tab.id }
    }
    default: throw new Error(`Unknown request: ${message.type}`)
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'status') { reply(state); return }
  if (message?.type === 'reconnect') { socket?.close(); socket = null; connect().then(() => reply(state)); return true }
})

chrome.alarms.create('devc-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
