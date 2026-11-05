# Implementation status

## v0.2.0 — AI Brain (2026-11-05)

### Delivered
- **Local AI chat** via Ollama `/api/chat` (loopback `127.0.0.1:11434` only), streamed token-by-token into an Assistant view.
- **Automatic project context** (`src/main/context-builder.ts`): project summary, stack, scripts, pending tasks, file tree, key files (`package.json`, `README.md`) and files relevant to the question are injected into the system prompt. Budgeted (~14k chars) for 8 GB RAM machines.
- **Read-only agent tools** (`src/main/agent.ts`, `src/main/project-tools.ts`): `list_files`, `read_file`, `search_code`. Up to 4 tool rounds per answer. Models without tool support automatically fall back to context-only answers.
- **Permission engine** (`src/main/permission-engine.ts`): Guide / Supervised / Autonomous modes, fail-closed for unknown actions, payments always denied.
- **Emergency STOP**: aborts every running AI request and tool loop.
- **Audit log** of every tool call and mode change (SQLite, capped at 1000 rows), visible in *Security & activity*.
- **Chat history per project** in local SQLite, secrets redacted before storage and before being sent to the model.
- Secret protection for AI reads: `.env*` (except `.env.example`), keys, certs, `.ssh`, `.aws`, `.npmrc`, `.git`, credentials files are blocked; path traversal, absolute paths and symlink escapes rejected; inline tokens redacted.
- Fixed v0.1.0 type error (`isMainFrame`) — `npm run typecheck` now passes.

### Verified in the build environment (Linux)
- `npm install`, `npm run typecheck`, `npm run build`: pass.
- `npm test`: 26 tests pass (permission engine, safe paths, context builder, NDJSON streaming, agent loop, emergency stop, tool fallback).
- Electron app launched headless (Xvfb) against an Ollama-compatible mock server: overview, assistant chat with a tool round + streamed answer, and audit view rendered with no console errors; `require` not exposed to the renderer.

### Not verified
- A real Ollama model (no access to the Ollama registry from the build environment) — answer quality depends on the model you pull.
- Windows-specific run and the NSIS installer.

## Next milestone (v0.3.0)
1. Supervised file edits: AI proposes a diff → developer approves → write + Git checkpoint.
2. Approval prompts in the UI for `ask` decisions.
3. Terminal observer (read output of `npm run dev`) and running test scripts.
4. Screen awareness (Electron desktop capturer, event-based, password fields masked).
5. Chrome extension for reading the active tab (e.g. Razorpay dashboard).
