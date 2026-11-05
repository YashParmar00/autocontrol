# Dev Companion

A local-first AI developer companion for Windows. It understands your project, your terminal, your screen and your Chrome tab, does the work you approve, and keeps passwords and API keys away from the AI.

## Features (v0.5.0)

| | |
|---|---|
| **Assistant** | Chat with a local Ollama model that already knows your project. Streams answers; history per project. |
| **Code** | Reads files itself, edits with a diff you approve, every edit has an **Undo** checkpoint. |
| **Terminal** | Runs package.json scripts (tests, builds, dev servers), reads their output, installs packages after approval. |
| **Screen** | 📷 On request, a local vision model looks at your screen (default OFF). |
| **Chrome** | Extension lets the AI read the active tab, fill fields and click buttons you approve. Payments are never clicked. |
| **Vault** | Store API keys encrypted (DPAPI). The AI uses them by name (`{{vault:NAME}}`, env vars) and never sees them. |
| **Control** | Guide / Supervised / Autonomous modes, approval cards, **STOP**, audit log. |
| **Mini** | Floating always-on-top assistant: **Ctrl+Shift+Space**. |

## Quick start

```bash
# 1. Ollama (https://ollama.com) + models
ollama pull qwen3:4b       # chat + tools (8 GB RAM: qwen3:1.7b is lighter)
ollama pull qwen3-vl:2b    # optional, for screen awareness

# 2. App
npm install
npm run dev
```

1. **Overview** → Select project folder.
2. **Assistant** → pick mode (start with **Supervised**) and ask.
3. Optional: **Security & activity** → turn on Screen awareness / Chrome bridge, add secrets to the Vault.
4. Chrome extension: `chrome://extensions` → Developer mode → Load unpacked → `apps/browser-extension` → paste the pairing token.

Windows installer: GitHub → Actions → **Windows installer** → Run workflow → download the artifact (or push a `v*` tag for a release).

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model and [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for what was tested.

## Development

Requirements: Windows 10/11 x64 (also runs on macOS/Linux), Node.js 22.12+.

```bash
npm run dev         # app with hot reload (or double-click START-WINDOWS.cmd)
npm run typecheck
npm test
npm run build
npm run package:win # Windows installer (needs Windows, or use the GitHub Actions workflow)
```

| Folder | What |
|---|---|
| `src/main` | Electron main: agent loop, tools, permission engine, vault, bridge, processes, SQLite store |
| `src/preload` | Typed, narrow IPC bridge |
| `src/renderer` | React UI (main window + `#mini` floating window) |
| `src/shared` | Types shared by main and UI |
| `apps/browser-extension` | Chrome MV3 extension (bridge) |
| `tests` | Vitest suites |

## Safety rules (enforced in code)

- `.env`, keys, passwords, tokens, cookies and OTPs never reach the model.
- Password/OTP/card fields are never read or filled with AI text.
- Edits, scripts, installs, form fills/clicks need approval in Supervised mode; external actions always ask.
- Payments are never automated.
- The AI never gets a raw shell or unrestricted file access.
