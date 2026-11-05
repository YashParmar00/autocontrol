const SECRET_ASSIGNMENT = /(^|[\s"'`])((?:[A-Za-z_][A-Za-z0-9-]*[_-])?(?:API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET))(\s*[:=]\s*)([^\s,;]+)/gim
const PROVIDER_TOKEN = /\b(?:sk_live|sk_test|rzp_live|rzp_test|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** Scrub common credential patterns before task notes are persisted locally. */
export function redactSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}[REDACTED]`)
    .replace(PROVIDER_TOKEN, '[REDACTED_TOKEN]')
    .replace(BEARER_TOKEN, '$1 [REDACTED_TOKEN]')
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED_PRIVATE_KEY]')
}
