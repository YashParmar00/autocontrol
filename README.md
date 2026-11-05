# Dev Companion

A local-first AI development companion for Windows. The product goal is to understand the developer's active project and workflow, keep useful context, and perform approved work while the developer remains in control.

## Current implementation (0.1.0)

- Electron desktop shell with a React + TypeScript renderer.
- Hardened renderer boundary: `contextIsolation`, `sandbox`, `nodeIntegration: false`, strict IPC allow-list, sender validation, and navigation/window-open restrictions.
- User-selected project folder scanning (no background drive crawling).
- Project metadata and file tree inspection, with common build folders and secret-like files excluded.
- Local task notes persisted under Electron's per-user app data directory (`memory.json`). The store is intentionally small and replaceable; SQLite migration is planned before richer memory/search is introduced.
- Ollama health check against `127.0.0.1:11434` only. It reads model names, never prompts a model.
- No screen capture, browser control, terminal execution, credential access, or autonomous actions in this starter.

## Requirements

- Windows 10/11 x64 (development tested target; not yet validated on this container)
- Node.js 22.16+ and npm
- Ollama is optional. Install it separately to use the local runtime check.

## Setup

```bash
npm install
npm run dev
```

Type-check and test:

```bash
npm run typecheck
npm test
```

Build the desktop bundle:

```bash
npm run build
```

Create a Windows installer:

```bash
npm run package:win
```

## Project scan security

The first version only scans a folder that the user explicitly selects. It does not follow symbolic links and skips `node_modules`, `.git`, build outputs, `.env*`, private-key extensions, and common credential-like filenames. It reads only the root `package.json` for dependency and script-name detection; it does not read `.env` or source-code contents.

This is a conservative baseline, not a guarantee that every possible secret naming convention is detected. Do not add real secrets to the repository.

## Ollama

The connection check calls `GET http://127.0.0.1:11434/api/tags`. It does not use cloud AI. No AI inference or chat prompt is wired yet.

## Architecture roadmap

1. **Foundation (current):** desktop shell, project context, task memory, local runtime status.
2. **Context intelligence:** user-enabled screen snapshots, Windows UI Automation, and a Chrome extension with explicit per-site permissions.
3. **Agent runtime:** task planner, policy-gated tools, code diffs, sandboxed terminal runner, and verification.
4. **Security hardening:** Windows Credential Manager/DPAPI integration, secret redaction, audit history, Git checkpoints, and emergency stop.
5. **Memory upgrade:** SQLite-backed project/task/decision memory with migrations and retrieval.

## Non-negotiable safety rules

- Never send `.env`, passwords, API tokens, browser cookies, private keys, or OTPs to a model.
- Browser password fields and sensitive regions must be excluded from context collection.
- File edits, package installs, shell commands, form submissions, email sends, payments, and deployments need separate permissions.
- Payments and production deployment always require explicit user confirmation.
- AI never receives unrestricted shell or filesystem access.

## Repository status

This workspace was initialized as a local Git repository for the starter implementation. A remote GitHub repository still needs to be created from the user's GitHub account, then configured as `origin` and pushed.
