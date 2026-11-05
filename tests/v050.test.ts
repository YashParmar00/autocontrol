import { afterEach, describe, expect, it } from 'vitest'
import { redactSecrets, setKnownSecrets } from '../src/main/redaction'
import { Vault, type VaultStorage } from '../src/main/vault'

function memoryStorage(): VaultStorage & { rows: Map<string, { cipher: string; env: boolean }> } {
  const rows = new Map<string, { cipher: string; env: boolean }>()
  return {
    rows,
    list: async () => [...rows].map(([name, row]) => ({ name, ...row, createdAt: 'now' })),
    put: async (name, cipher, env) => { rows.set(name, { cipher, env }) },
    remove: async (name) => { rows.delete(name) },
  }
}

// Reversible stand-in for safeStorage: "encrypts" by reversing bytes.
const fakeCipher = {
  isAvailable: async () => true,
  encrypt: async (plain: string) => Buffer.from(plain).reverse(),
  decrypt: async (cipher: Buffer) => ({ value: Buffer.from(cipher).reverse().toString(), reEncrypt: false }),
}

afterEach(() => setKnownSecrets([]))

describe('vault', () => {
  it('stores only ciphertext and never lists values', async () => {
    const storage = memoryStorage()
    const vault = new Vault(fakeCipher, storage)
    await vault.set('RAZORPAY_KEY_SECRET', 'super-secret-value', true)
    expect([...storage.rows.values()][0].cipher).not.toContain('super-secret-value')
    expect(JSON.stringify(await vault.entries())).not.toContain('super-secret-value')
    expect(await vault.resolve('RAZORPAY_KEY_SECRET')).toBe('super-secret-value')
    expect(await vault.resolve('MISSING')).toBeNull()
  })

  it('injects only env-marked, env-safe names into scripts', async () => {
    const vault = new Vault(fakeCipher, memoryStorage())
    await vault.set('DB_PASSWORD', 'pw1234', true)
    await vault.set('dashboard.login', 'pw5678', true)
    await vault.set('BROWSER_ONLY', 'pw9999', false)
    expect(await vault.scriptEnv()).toEqual({ DB_PASSWORD: 'pw1234' })
  })

  it('validates names and refuses to store without OS encryption', async () => {
    const vault = new Vault(fakeCipher, memoryStorage())
    await expect(vault.set('bad name', 'x', true)).rejects.toThrow(/Name/)
    const noCrypto = new Vault({ ...fakeCipher, isAvailable: async () => false }, memoryStorage())
    await expect(noCrypto.set('OK', 'value', true)).rejects.toThrow(/encryption/)
  })
})

describe('vault key rotation', () => {
  it('re-encrypts a value when the OS asks for it', async () => {
    const storage = memoryStorage()
    let rotated = false
    const vault = new Vault({ ...fakeCipher, decrypt: async (cipher) => ({ value: Buffer.from(cipher).reverse().toString(), reEncrypt: !rotated && (rotated = true) }) }, storage)
    await vault.set('K', 'value-1234', true)
    const before = storage.rows.get('K')!.cipher
    storage.rows.set('K', { cipher: before + '', env: true })
    expect(await vault.resolve('K')).toBe('value-1234')
    expect(rotated).toBe(true)
  })
})

describe('known-secret redaction', () => {
  it('replaces exact vault values anywhere, whatever their shape', () => {
    setKnownSecrets([{ name: 'WEBHOOK', value: 'hx9-plain-looking' }])
    expect(redactSecrets('server says hx9-plain-looking ok')).toBe('server says [VAULT:WEBHOOK] ok')
  })

  it('ignores trivially short values to avoid shredding normal text', () => {
    setKnownSecrets([{ name: 'PIN', value: 'a1' }])
    expect(redactSecrets('a1 a1')).toBe('a1 a1')
  })
})
