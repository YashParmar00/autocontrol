import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/main/redaction'

describe('redactSecrets', () => {
  it('redacts common key/value credentials', () => {
    expect(redactSecrets('Set RAZORPAY_API_KEY=rzp_live_123456789012 and password: hello'))
      .toBe('Set RAZORPAY_API_KEY=[REDACTED] and password: [REDACTED]')
  })

  it('redacts provider tokens and private key blocks', () => {
    const text = 'token sk_live_1234567890 -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----'
    expect(redactSecrets(text)).toContain('[REDACTED_TOKEN]')
    expect(redactSecrets(text)).toContain('[REDACTED_PRIVATE_KEY]')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop123456')).toBe('Authorization: Bearer [REDACTED_TOKEN]')
  })
})

describe('extra redaction patterns', () => {
  it('hides tokens, database urls and url credentials', async () => {
    const { redactSecrets } = await import('../src/main/redaction')
    expect(redactSecrets('TOKEN=abc12345')).toBe('TOKEN=[REDACTED]')
    expect(redactSecrets('MONGODB_URI=mongodb+srv://yash:hunter2@cluster0.x.net/db')).not.toContain('hunter2')
    expect(redactSecrets('connect postgres://admin:s3cret@localhost:5432/app')).toBe('connect postgres://admin:[REDACTED]@localhost:5432/app')
    expect(redactSecrets('const tokenizer = createTokenizer()')).toBe('const tokenizer = createTokenizer()')
  })
})
