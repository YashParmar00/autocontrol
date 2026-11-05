const SECRET_ASSIGNMENT = /(^|[\s"'`])((?:[A-Za-z_][A-Za-z0-9-]*[_-])?(?:API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|PASSWORD|PASSWD|PWD|SECRET|PRIVATE[_-]?KEY|DATABASE[_-]?URL|MONGO(?:DB)?[_-]?URI|CONNECTION[_-]?STRING))(\s*[:=]\s*)([^\s,;]+)/gim
const PROVIDER_TOKEN = /\b(?:sk_live|sk_test|rzp_live|rzp_test|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** Scrub common credential patterns before task notes are persisted locally. */
export function redactSecrets(value: string): string {
  return redactUrlCredentials(value)
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}[REDACTED]`)
    .replace(PROVIDER_TOKEN, '[REDACTED_TOKEN]')
    .replace(BEARER_TOKEN, '$1 [REDACTED_TOKEN]')
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED_PRIVATE_KEY]')
}

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi

/** Also hide user:password@ in connection strings like mongodb+srv://user:pass@host. */
export function redactUrlCredentials(value: string): string {
  return value.replace(URL_CREDENTIALS, '$1$2:[REDACTED]@')
}
