# Roadmap

## Done
- **0.1** Electron + React shell, secure IPC, project scan, SQLite memory, Ollama check
- **0.2** Local AI chat with automatic project context, read-only tools, permission engine, audit log, STOP
- **0.3** Approvals with diff preview, code edits with checkpoints/Undo, scripts, background processes, terminal view, package installs
- **0.4** Screen awareness (vision model), Chrome extension bridge: read tab, fill fields, click (payments blocked)
- **0.5** Credential vault (DPAPI), `{{vault:NAME}}`, secret redaction everywhere, floating mini assistant, read-aloud, CI + Windows installer workflow

## Next
- Speech-to-text inside the app (local Whisper). Today: Windows **Win+H** voice typing works in the chat box.
- Windows UI Automation for native apps (read structured UI instead of pixels).
- Git integration: show diff of all AI changes since a point, commit on request.
- Multi-step plans with a visible checklist the developer can edit before execution.
- Code signing for the Windows installer.
