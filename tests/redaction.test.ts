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
