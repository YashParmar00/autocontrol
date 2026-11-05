# Security model (v0.5.0)

Goal: the AI can see and do a lot, but **secrets never reach the model** and **nothing risky happens without you**.

## Trust boundaries

| Layer | Trust | What it can do |
|---|---|---|
| Renderer (React UI) | Untrusted | No Node.js, sandboxed, CSP. Talks only through the typed preload API. |
| Preload | Narrow | Exposes named IPC calls only; never the raw `ipcRenderer`. |
| Main process | Trusted | Validates every sender (main + floating window only, main frame, own URL) and every argument with zod. |
| Local model (Ollama) | Untrusted output | Only reaches the world through the tool registry → permission engine. |
| Chrome extension | Paired | Token-authenticated WebSocket on `127.0.0.1`; only `chrome-extension://` origins accepted. |

## Permission engine (`src/main/permission-engine.ts`)

Every tool call is *planned* first (arguments validated, preview built), then decided:

| Category | Guide | Supervised | Autonomous |
|---|---|---|---|
| read project / terminal / screen / tab | allow | allow | allow |
| edit code, run test scripts | deny | **ask** | allow |
| run other scripts, install packages, DB, forms/clicks, messages, deploy | deny | **ask** | **ask** |
| payment / purchase | **never** | **never** | **never** |

Unknown categories are denied. In Guide mode mutating tools are not even offered to the model. "Ask" shows an approval card with the exact diff / command / form values; no answer in 5 minutes = reject. **STOP** aborts AI requests, rejects pending approvals and kills every process the app started.

## Secrets

1. **Never read:** `.env*` (except `.env.example`/`.sample`), keys/certs, `.ssh`, `.aws`, `.npmrc`, `.netrc`, `.git`, credentials files. Path traversal, absolute paths and symlink escapes are rejected after `realpath`.
2. **Never written by the AI:** same list; writes are re-validated right before they touch disk.
3. **Redacted everywhere** (prompts, tool output, terminal, chat history, audit log): API keys, tokens, passwords, bearer tokens, private keys, `user:pass@` in URLs, DB connection strings, provider token formats (`rzp_*`, `sk_*`, `ghp_*`, …), and the exact value of every vault secret (`[VAULT:NAME]`).
4. **Placeholder guard:** the AI cannot write `[REDACTED]` back into a file (that would overwrite the real secret).
5. **Vault:** values encrypted with Electron `safeStorage` (Windows DPAPI). Write-only from the UI. If the OS has no real encryption (Linux `basic_text`), the vault refuses to store anything. The AI uses secrets only by name: `{{vault:NAME}}` in a browser field (resolved in the main process) or as env vars for scripts it runs.
6. **Browser:** values of password / OTP / card / CVV / secret / token / API-key / PAN / Aadhaar fields never leave the page and can't be filled with AI-written text (vault secrets only).
7. **Screen:** capture only on request, only when enabled, never saved to disk. Our own windows use content protection so chat/approvals/vault appear black. ⚠ Anything else visible on screen can reach the local vision model — close password managers before asking.

## Processes

Only `package.json` scripts and validated package names are run (`spawn`, no shell strings on macOS/Linux; on Windows `.cmd` needs a shell, so every argument is checked against shell metacharacters). Timeouts, 200 KB output caps, process-tree kill.

## Checkpoints

Every AI file write stores the previous content first. **Undo** restores it (or deletes a file the AI created).

## Known limits

- The model is only as careful as its prompt; the permission engine, not the model, is the safety boundary.
- Screen capture cannot mask secrets inside other apps' pixels.
- Local data (SQLite memory, audit log) is protected by your Windows account, not separately encrypted; it never contains vault values.

## Electron preload format

The main process is built as ESM. The preload is emitted as a single CommonJS `.cjs` bundle because Electron's sandboxed preload loader does not support ESM imports.
