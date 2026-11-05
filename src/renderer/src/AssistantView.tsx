import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Camera, Check, BrainCircuit, PictureInPicture2, Volume2, VolumeX, Eraser, Eye, LoaderCircle, OctagonX, SendHorizontal, ShieldAlert, ShieldCheck, Sparkles, Wrench, Zap } from 'lucide-react'
import type { ApprovalRequest, AssistantSettings, AutonomyMode, ChatMessage, OllamaStatus, ProjectSummary } from '../../shared/contracts'

type LiveTool = { tool: string; summary: string; decision: string; outcome: string }

function toolLabel(tool: LiveTool): string {
  if (tool.decision === 'deny') return ' — blocked in this mode'
  if (tool.outcome === 'error') return ' — failed'
  if (tool.decision === 'ask') return tool.outcome === 'ok' ? ' — approved by you' : ' — rejected'
  return ''
}

const MODES: Array<{ id: AutonomyMode; label: string; hint: string; icon: typeof Eye }> = [
  { id: 'guide', label: 'Guide', hint: 'Sirf samjhayega, kuch change nahi karega', icon: Eye },
  { id: 'supervised', label: 'Supervised', hint: 'Har change se pehle approval lega', icon: ShieldCheck },
  { id: 'autonomous', label: 'Autonomous', hint: 'Local changes khud, external actions par approval', icon: Zap },
]

const SUGGESTIONS = [
  'Is project ka structure samjhao — kya kya bana hua hai?',
  'Razorpay integrate karna hai — is codebase mein kahan aur kaise karu?',
  'Kaunse scripts hain aur project kaise run karu?',
]

/** Renders fenced code blocks as <pre>, everything else as plain text. No HTML injection. */
function MessageBody({ text }: { text: string }) {
  const parts = text.split(/```/)
  return (
    <>
      {parts.map((part, index) => index % 2 === 1
        ? <pre key={index} className="chat-code"><code>{part.replace(/^[\w-]*\n/, '')}</code></pre>
        : part.trim() ? <p key={index} className="chat-text">{part.trim()}</p> : null)}
    </>
  )
}

function DiffPreview({ text }: { text: string }) {
  return (
    <pre className="approval-preview">
      {text.split('\n').map((line, index) => (
        <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>
      ))}
    </pre>
  )
}

function ApprovalCard({ approval, onAnswer }: { approval: ApprovalRequest; onAnswer: (approved: boolean) => void }) {
  return (
    <div className="approval-card">
      <div className="approval-head"><ShieldAlert size={14} /> <strong>Approval needed</strong> <code>{approval.summary}</code></div>
      <DiffPreview text={approval.preview} />
      <div className="approval-actions">
        <button className="approve-button" onClick={() => onAnswer(true)}><Check size={14} /> Approve</button>
        <button className="outline-button" onClick={() => onAnswer(false)}>Reject</button>
        <span className="approval-hint">5 min mein jawab nahi diya to auto-reject</span>
      </div>
    </div>
  )
}

export function AssistantView(props: {
  project: ProjectSummary | null
  ollama: OllamaStatus | null
  onRefreshOllama: () => void
  compact?: boolean
}) {
  const { project, ollama } = props
  const [settings, setSettings] = useState<AssistantSettings>({ model: null, mode: 'supervised', visionModel: null, screenEnabled: false, browserEnabled: false })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState('')
  const [liveTools, setLiveTools] = useState<LiveTool[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [activeRequest, setActiveRequest] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [attachScreen, setAttachScreen] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeRequest

  useEffect(() => {
    void window.devCompanion.getSettings().then(setSettings)
    void window.devCompanion.getChatHistory().then(setMessages)
  }, [project?.path])

  // Pick the first installed model automatically if none chosen yet.
  useEffect(() => {
    if (!settings.model && ollama?.models.length) {
      void window.devCompanion.updateSettings({ model: ollama.models[0] }).then(setSettings)
    }
  }, [ollama, settings.model])

  useEffect(() => window.devCompanion.onChatEvent((event) => {
    if (event.requestId !== activeRef.current) return
    if (event.type === 'token') setStreaming((current) => current + event.text)
    else if (event.type === 'tool') setLiveTools((current) => [...current, { tool: event.tool, summary: event.summary, decision: event.decision, outcome: event.outcome }])
    else if (event.type === 'approval') setApprovals((current) => [...current, event.approval])
    else {
      if (event.type === 'done') setMessages((current) => [...current, event.message])
      else setError(event.message)
      setStreaming('')
      setLiveTools([])
      setApprovals([])
      setActiveRequest(null)
    }
  }), [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming, liveTools])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || activeRequest) return
    setError('')
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, projectPath: project?.path ?? '', role: 'user', content: trimmed, createdAt: new Date().toISOString() }
    setMessages((current) => [...current, optimistic])
    setDraft('')
    try {
      const requestId = await window.devCompanion.sendChat(trimmed, attachScreen ? { attachScreen: true } : undefined)
      setAttachScreen(false)
      activeRef.current = requestId
      setActiveRequest(requestId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not send.')
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void send(draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  async function answerApproval(id: string, approved: boolean) {
    setApprovals((current) => current.filter((approval) => approval.id !== id))
    await window.devCompanion.respondApproval(id, approved)
  }

  async function changeMode(mode: AutonomyMode) {
    setSettings(await window.devCompanion.updateSettings({ mode }))
  }

  async function changeModel(model: string) {
    setSettings(await window.devCompanion.updateSettings({ model }))
  }

  async function stopAll() {
    window.speechSynthesis?.cancel()
    setSpeakingId(null)
    await window.devCompanion.stopAll()
  }

  /** Offline text-to-speech (Windows voices). Code blocks are skipped. */
  function speak(message: ChatMessage) {
    const synth = window.speechSynthesis
    if (!synth) return
    if (speakingId === message.id) { synth.cancel(); setSpeakingId(null); return }
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(message.content.replace(/```[\s\S]*?```/g, ' (code) ').slice(0, 4_000))
    const voices = synth.getVoices()
    utterance.voice = voices.find((voice) => /hi-IN|en-IN/.test(voice.lang)) ?? voices.find((voice) => voice.lang.startsWith('en')) ?? null
    utterance.onend = () => setSpeakingId(null)
    setSpeakingId(message.id)
    synth.speak(utterance)
  }

  async function clearHistory() {
    await window.devCompanion.clearChatHistory()
    setMessages([])
  }

  const noModels = ollama && (!ollama.connected || !ollama.models.length)

  return (
    <div className={`assistant-view ${props.compact ? 'compact' : ''}`}>
      <div className="assistant-toolbar">
        <div className="mode-switch" role="radiogroup" aria-label="Autonomy mode">
          {MODES.map(({ id, label, hint, icon: Icon }) => (
            <button key={id} role="radio" aria-checked={settings.mode === id} title={hint}
              className={`mode-option ${settings.mode === id ? 'selected' : ''}`} onClick={() => void changeMode(id)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select className="model-select" value={settings.model ?? ''} onChange={(event) => void changeModel(event.target.value)} disabled={!ollama?.models.length}>
            {!settings.model && <option value="">No model</option>}
            {settings.model && !ollama?.models.includes(settings.model) && <option value={settings.model}>{settings.model}</option>}
            {ollama?.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <button className="outline-button" onClick={() => void clearHistory()} disabled={!!activeRequest || !messages.length} title="Clear this project's chat"><Eraser size={14} /> Clear</button>
          {!props.compact && <button className="outline-button" onClick={() => void window.devCompanion.toggleFloatingPanel()} title="Floating mini assistant (Ctrl+Shift+Space)"><PictureInPicture2 size={14} /> Mini</button>}
          <button className="stop-button" onClick={() => void stopAll()} title="Emergency stop — aborts every running AI action"><OctagonX size={15} /> STOP</button>
        </div>
      </div>

      <div className="mode-explainer">{MODES.find((mode) => mode.id === settings.mode)?.hint} · Payments hamesha manual · Secrets AI ko kabhi nahi dikhte{settings.screenEnabled ? ' · 📷 Screen ON' : ''}{settings.browserEnabled ? ' · 🌐 Browser ON' : ''}</div>

      {noModels && (
        <div className="setup-card">
          <Sparkles size={18} />
          <div>
            <strong>{ollama?.connected ? 'Koi local model install nahi hai' : 'Ollama chal nahi raha'}</strong>
            <span>{ollama?.connected
              ? 'Terminal mein chalao: ollama pull qwen3:4b  (8GB RAM ke liye qwen3:1.7b ya llama3.2:3b bhi theek hai)'
              : 'Ollama install karke start karo (ollama.com), phir "Check again" dabao.'}</span>
          </div>
          <button className="outline-button" onClick={props.onRefreshOllama}>Check again</button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {!messages.length && !activeRequest && (
          <div className="chat-empty">
            <div className="hero-icon dark"><BrainCircuit size={22} /></div>
            <strong>{project ? `${project.name} ka context ready hai` : 'Project select karo for full context'}</strong>
            <p>Screenshot ya code paste karne ki zarurat nahi — main project files khud padh leta hoon (.env aur keys chhod ke).</p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} className="suggestion" onClick={() => void send(suggestion)} disabled={!settings.model}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            {message.toolTrace?.length ? <div className="tool-trace"><Wrench size={11} /> {message.toolTrace.join(' · ')}</div> : null}
            <div className="chat-bubble"><MessageBody text={message.content} /></div>
            {message.role === 'assistant' && (
              <button className="speak-button" onClick={() => speak(message)} aria-label={speakingId === message.id ? 'Stop reading' : 'Read aloud'}>
                {speakingId === message.id ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
            )}
          </div>
        ))}
        {activeRequest && (
          <div className="chat-message assistant">
            {liveTools.map((tool, index) => (
              <div key={index} className={`tool-chip ${tool.outcome === 'ok' ? 'ok' : 'bad'}`}>
                {tool.outcome === 'ok' ? <Wrench size={11} /> : <ShieldAlert size={11} />} {tool.summary}{toolLabel(tool)}
              </div>
            ))}
            {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onAnswer={(approved) => void answerApproval(approval.id, approved)} />)}
            <div className="chat-bubble">
              {streaming ? <MessageBody text={streaming} /> : <span className="thinking"><LoaderCircle size={14} className="spin" /> {approvals.length ? 'Aapke approval ka wait…' : 'Soch raha hoon…'}</span>}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error-banner compact"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}

      <form className="chat-input" onSubmit={onSubmit}>
        {settings.screenEnabled && settings.visionModel && (
          <button type="button" className={`attach-button ${attachScreen ? 'on' : ''}`} onClick={() => setAttachScreen(!attachScreen)}
            title="Is sawal ke saath abhi ki screen ka screenshot AI ko dikhao (vision model se describe hoga)" aria-pressed={attachScreen}>
            <Camera size={16} />
          </button>
        )}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} rows={2} maxLength={8000}
          placeholder={settings.model ? 'Kuch bhi poochho… (Enter = send · Shift+Enter = new line · Win+H = bol ke likho)' : 'Pehle Ollama model select karo'} disabled={!settings.model} />
        <button type="submit" className="primary-button" disabled={!draft.trim() || !!activeRequest || !settings.model}>
          {activeRequest ? <LoaderCircle size={16} className="spin" /> : <SendHorizontal size={16} />}
        </button>
      </form>
    </div>
  )
}
