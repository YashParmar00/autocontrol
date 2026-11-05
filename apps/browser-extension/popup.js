const tokenInput = document.getElementById('token')
const portInput = document.getElementById('port')
const statusBox = document.getElementById('status')

function show(state) {
  statusBox.textContent = state?.connected ? 'Connected to desktop app ✓' : `Not connected${state?.error ? ` — ${state.error}` : ''}`
  statusBox.className = `status ${state?.connected ? 'on' : ''}`
}

const saved = await chrome.storage.local.get(['token', 'port'])
tokenInput.value = saved.token || ''
portInput.value = saved.port || 47821
show(await chrome.runtime.sendMessage({ type: 'status' }))

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: tokenInput.value.trim(), port: Number(portInput.value) || 47821 })
  statusBox.textContent = 'Connecting…'
  show(await chrome.runtime.sendMessage({ type: 'reconnect' }))
  setTimeout(async () => show(await chrome.runtime.sendMessage({ type: 'status' })), 1500)
})
