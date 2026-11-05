# Implementation status — v0.5.0 (2026-11-05)

## Verified
- `npm ci`, `npm run typecheck`, `npm run build`, `npm audit` (0 vulnerabilities).
- `npm test`: 57 tests — permission engine, safe read/write paths, diff, approvals, process manager (real npm scripts, timeout, kill), redaction, browser bridge (real WebSocket, origin + token checks), browser/screen tools, vault.
- End-to-end in the real Electron app (headless Linux, Xvfb) against a scripted Ollama-compatible server:
  - Supervised: AI read `src/server.js` → edit approval with diff (file unchanged until Approve) → file changed → test script approval → `PASS` → `.env` read blocked → Undo restored the file.
  - Real Chromium + the extension: paired with token, AI read the tab, filled the URL field after approval, **did not** fill the password field, "Pay now" was blocked, "Create Webhook" clicked after approval. No secret reached the model.
  - Screen awareness: preview capture, `look_at_screen` and the camera-attach button sent a real screenshot to the vision model.
  - Floating mini window opens, shares history, IPC trusted.
  - Terminal: started `dev`, output shown; STOP aborted the AI request and killed the process.
  - Vault correctly refuses to store without OS encryption.

## Not verified here
- A real Ollama model (registry blocked in the build environment). Answer quality depends on the model.
- Windows itself: DPAPI vault encryption, content protection, `.cmd` spawning, NSIS installer. The CI workflow runs tests on `windows-latest`; the installer workflow builds the `.exe`.

## Recommended models (8 GB RAM)
- Chat + tools: `qwen3:4b` (or `qwen3:1.7b` if slow)
- Vision: `qwen3-vl:2b`
