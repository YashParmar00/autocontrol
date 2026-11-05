import { useEffect, useState } from 'react'
import { Camera, Copy, Globe, RefreshCw } from 'lucide-react'
import type { AssistantSettings, BridgeInfo, OllamaStatus } from '../../shared/contracts'

export function CapabilitiesPanel({ ollama }: { ollama: OllamaStatus | null }) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [bridge, setBridge] = useState<BridgeInfo | null>(null)
  const [preview, setPreview] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    setSettings(await window.devCompanion.getSettings())
    setBridge(await window.devCompanion.getBridgeInfo())
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void window.devCompanion.getBridgeInfo().then(setBridge), 3_000)
    return () => clearInterval(timer)
  }, [])

  async function update(patch: Partial<AssistantSettings>) {
    setError('')
    try {
      setSettings(await window.devCompanion.updateSettings(patch))
      setBridge(await window.devCompanion.getBridgeInfo())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Update failed') }
  }

  async function takePreview() {
    setError('')
    try { setPreview(await window.devCompanion.previewScreen()) } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Capture failed')
    }
  }

  if (!settings) return null
  const vision = ollama?.visionModels ?? []

  return (
    <article className="panel">
      <div className="panel-header"><div><h3>Screen & browser awareness</h3><p>Dono default OFF hain. ON karne par hi AI dekh sakta hai.</p></div></div>
      {error && <div className="error-banner compact"><span>{error}</span></div>}

      <div className="capability-row">
        <div className="capability-copy"><Camera size={16} /><div><strong>Screen awareness</strong><span>Sirf tab screenshot leta hai jab AI ya aap maango. Disk par save nahi hota. Ye app khud screenshot mein black dikhta hai.</span></div></div>
        <label className="switch"><input type="checkbox" checked={settings.screenEnabled} onChange={(event) => void update({ screenEnabled: event.target.checked })} /><span /></label>
      </div>
      {settings.screenEnabled && (
        <div className="capability-detail">
          <label className="row-label">VISION MODEL</label>
          <select className="model-select" value={settings.visionModel ?? ''} onChange={(event) => void update({ visionModel: event.target.value || null })}>
            <option value="">Select…</option>
            {settings.visionModel && !vision.includes(settings.visionModel) && <option value={settings.visionModel}>{settings.visionModel}</option>}
            {vision.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          {!vision.length && <div className="runtime-help">Koi vision model nahi mila. Chalao: <code>ollama pull qwen3-vl:2b</code> (8GB RAM) ya <code>qwen3-vl:4b</code>.</div>}
          <button className="outline-button" onClick={() => void takePreview()}><Camera size={13} /> Preview: AI ko kya dikhega</button>
          {preview && <img className="screen-preview" src={preview} alt="Screen capture preview" />}
          <div className="runtime-help">Dhyan do: screenshot mein jo bhi dikh raha hai (jaise khula password manager) model tak jaa sakta hai. Vision model ko secrets na likhne ka instruction hai aur output redact hota hai, phir bhi sensitive window band rakho.</div>
        </div>
      )}

      <div className="capability-row">
        <div className="capability-copy"><Globe size={16} /><div><strong>Chrome bridge</strong><span>Active tab padhna (password/card/OTP values kabhi nahi) aur approve karne par fields fill karna.</span></div></div>
        <label className="switch"><input type="checkbox" checked={settings.browserEnabled} onChange={(event) => void update({ browserEnabled: event.target.checked })} /><span /></label>
      </div>
      {settings.browserEnabled && bridge && (
        <div className="capability-detail">
          <div className="bridge-status"><span className={`runtime-status-dot ${bridge.connected ? 'online' : ''}`} />
            {bridge.error ? bridge.error : bridge.connected ? `Extension connected (v${bridge.extensionVersion ?? '?'})` : bridge.listening ? `Waiting for extension on 127.0.0.1:${bridge.port}` : 'Not listening'}
          </div>
          <label className="row-label">PAIRING TOKEN</label>
          <div className="token-row">
            <code>{showToken ? bridge.token : '•'.repeat(24)}</code>
            <button className="outline-button" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
            <button className="outline-button" onClick={() => void navigator.clipboard.writeText(bridge.token)}><Copy size={12} /> Copy</button>
            <button className="outline-button" onClick={() => void window.devCompanion.rotateBridgeToken().then(setBridge)} title="Naya token — purana extension disconnect ho jayega"><RefreshCw size={12} /> New</button>
          </div>
          <div className="runtime-help">Extension install: chrome://extensions → Developer mode → Load unpacked → repo ka <code>apps/browser-extension</code> folder. Phir extension icon par click karke token paste karo.</div>
        </div>
      )}
    </article>
  )
}
