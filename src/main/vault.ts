import type { VaultEntry } from '../shared/contracts'

/**
 * Local credential vault. Values are encrypted with the OS (Windows DPAPI / macOS Keychain /
 * Linux secret service via Electron safeStorage) and are write-only from the UI:
 * nothing ever sends a stored value back to the renderer or to the model.
 *
 * The AI can *use* a secret only by name:
 *   - {{vault:NAME}} in fill_browser_fields is resolved here, in the main process;
 *   - secrets marked "env" are injected as environment variables into scripts the AI runs.
 * Every stored value is also registered with the redactor, so if it ever shows up in
 * terminal output, a file or a page, it is replaced by [VAULT:NAME].
 */

export const VAULT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export type Cipher = {
  isAvailable: () => Promise<boolean>
  encrypt: (plain: string) => Promise<Buffer>
  /** `reEncrypt` is true when the OS key was rotated and the value should be stored again. */
  decrypt: (cipher: Buffer) => Promise<{ value: string; reEncrypt: boolean }>
}

export type VaultStorage = {
  list: () => Promise<Array<{ name: string; cipher: string; env: boolean; createdAt: string }>>
  put: (name: string, cipher: string, env: boolean) => Promise<void>
  remove: (name: string) => Promise<void>
}

export class Vault {
  constructor(private cipher: Cipher, private storage: VaultStorage) {}

  async available(): Promise<boolean> {
    try { return await this.cipher.isAvailable() } catch { return false }
  }

  async entries(): Promise<VaultEntry[]> {
    return (await this.storage.list()).map(({ name, env, createdAt }) => ({ name, env, createdAt }))
  }

  async set(name: string, value: string, env: boolean): Promise<void> {
    if (!VAULT_NAME.test(name)) throw new Error('Name: letters, numbers, _ . - only (e.g. RAZORPAY_KEY_SECRET).')
    if (!value || value.length > 8_192) throw new Error('Value must be 1–8192 characters.')
    if (!(await this.available())) throw new Error('OS encryption is not available on this computer, so secrets are not stored.')
    await this.storage.put(name, (await this.cipher.encrypt(value)).toString('base64'), env)
  }

  async remove(name: string): Promise<void> {
    await this.storage.remove(name)
  }

  /** Decrypt one secret for use inside the main process only. */
  async resolve(name: string): Promise<string | null> {
    const entry = (await this.storage.list()).find((candidate) => candidate.name === name)
    if (!entry || !(await this.available())) return null
    return this.decryptEntry(entry)
  }

  private async decryptEntry(entry: { name: string; cipher: string; env: boolean }): Promise<string | null> {
    try {
      const { value, reEncrypt } = await this.cipher.decrypt(Buffer.from(entry.cipher, 'base64'))
      if (reEncrypt) await this.storage.put(entry.name, (await this.cipher.encrypt(value)).toString('base64'), entry.env)
      return value
    } catch {
      return null
    }
  }

  /** All decrypted values (for the redactor) — never leaves the main process. */
  async allValues(): Promise<Array<{ name: string; value: string; env: boolean }>> {
    if (!(await this.available())) return []
    const result = []
    for (const entry of await this.storage.list()) {
      const value = await this.decryptEntry(entry)
      if (value !== null) result.push({ name: entry.name, value, env: entry.env })
    }
    return result
  }

  async scriptEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    for (const entry of await this.allValues()) if (entry.env && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) env[entry.name] = entry.value
    return env
  }
}
