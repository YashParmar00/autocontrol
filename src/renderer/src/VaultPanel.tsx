import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Lock, Trash2 } from 'lucide-react'
import type { VaultInfo } from '../../shared/contracts'

/** Write-only secret store. Values are sent to the main process once and never come back. */
export function VaultPanel() {
  const [vault, setVault] = useState<VaultInfo | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [env, setEnv] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { void window.devCompanion.getVault().then(setVault) }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      setVault(await window.devCompanion.setVaultSecret(name.trim(), value, env))
      setName('')
      setValue('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not save.')
    } finally {
      setValue('')
    }
  }

  async function remove(secret: string) {
    if (!window.confirm(`Delete ${secret} from the vault?`)) return
    setVault(await window.devCompanion.deleteVaultSecret(secret))
  }

  return (
    <article className="panel">
      <div className="panel-header"><div><h3>Credential vault</h3><p>API keys / passwords yahan rakho. AI sirf naam dekhta hai — value kabhi nahi. Windows par DPAPI se encrypt.</p></div><div className="panel-icon"><KeyRound size={17} /></div></div>
      {vault && !vault.available && <div className="error-banner compact"><span>Is computer par OS encryption available nahi hai, isliye vault band hai (plain text mein kabhi save nahi karte).</span></div>}
      {error && <div className="error-banner compact"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      <form className="vault-form" onSubmit={save}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="NAME e.g. RAZORPAY_KEY_SECRET" maxLength={64} spellCheck={false} disabled={!vault?.available} />
        <input value={value} onChange={(event) => setValue(event.target.value)} type="password" placeholder="Secret value" autoComplete="new-password" maxLength={8192} disabled={!vault?.available} />
        <label className="vault-env"><input type="checkbox" checked={env} onChange={(event) => setEnv(event.target.checked)} /> Scripts ko env var</label>
        <button className="primary-button" type="submit" disabled={!name.trim() || !value || !vault?.available}><Lock size={13} /> Save</button>
      </form>
      {vault?.entries.length ? vault.entries.map((entry) => (
        <div key={entry.name} className="checkpoint-row">
          <code>🔒 {entry.name}</code>
          <span className="audit-meta">{entry.env ? 'env var + {{vault:' + entry.name + '}}' : '{{vault:' + entry.name + '}} only'}</span>
          <button className="outline-button" onClick={() => void remove(entry.name)} aria-label={`Delete ${entry.name}`}><Trash2 size={12} /></button>
        </div>
      )) : <div className="memory-empty">Vault khaali hai.</div>}
      <div className="runtime-help">Use: browser field mein AI <code>{'{{vault:NAME}}'}</code> bharega (value yahin main process mein lagti hai). Terminal/file/page mein value dikhe to <code>[VAULT:NAME]</code> ban jaati hai.</div>
    </article>
  )
}
