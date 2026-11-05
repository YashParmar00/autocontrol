# Implementation roadmap

## Milestone 0.1 — foundation
- [x] Electron + React + TypeScript desktop shell
- [x] Secure preload bridge and IPC sender validation
- [x] Native folder selection
- [x] Conservative project structure scan
- [x] Local task memory persistence
- [x] Ollama loopback health check
- [ ] Verify install/build on the target Windows PC (not verified in this environment)

## Milestone 0.2 — richer project context
- [ ] SQLite migration and project schema
- [ ] Readme/manifest parsing with size and secret filters
- [ ] Git branch/status summary (read-only)
- [ ] Project-specific decisions and task milestones
- [ ] Local semantic search

## Milestone 0.3 — screen and browser awareness
- [ ] Explicit screen-observation toggle and visible indicator
- [ ] On-demand snapshot first; no continuous capture by default
- [ ] Windows UI Automation provider
- [ ] Chrome extension with per-site allow-list
- [ ] Password/OTP field and sensitive-region masking

## Milestone 0.4 — supervised agent tools
- [ ] Plan/approve/execute/verify loop
- [ ] File diff preview and Git checkpoint
- [ ] Sandboxed terminal runner and command allow-list
- [ ] Browser action planner with per-action approval
- [ ] Pause/cancel/emergency stop

## Milestone 0.5 — credential vault and hardening
- [ ] Windows Credential Manager / DPAPI adapter
- [ ] Secret-use capabilities that never return the value to the model
- [ ] Redaction tests for logs, memory, OCR, and prompts
- [ ] Threat model review and end-to-end Windows QA
