# Security model

## Trust boundaries

- **Renderer:** untrusted UI. No Node.js integration and no direct filesystem/network access beyond the Electron APIs exposed by the preload bridge.
- **Preload:** narrow, typed API surface. Only explicit IPC methods are exposed.
- **Main process:** validates the sender and validates all renderer-supplied values before performing privileged operations.
- **Project scanner:** only operates on a directory chosen through the native folder picker; excludes sensitive names, ignored directories, and symlinks.
- **Ollama:** loopback-only health check. The current implementation does not send prompts or project data.

## Rules for future agents

1. Use capability-scoped tools; never expose raw `fs`, `child_process`, or arbitrary URLs to the model.
2. Validate every argument with a schema and check path containment after resolving symlinks.
3. Require explicit approval for any write outside an agent-owned scratch directory.
4. Run terminal commands in a constrained working directory with command allow-lists, timeouts, output caps, and process termination support.
5. Redact secrets before screen/OCR/text/model context is assembled. Redaction happens before logging too.
6. Do not persist secrets in task memory, prompts, logs, crash reports, or analytics.
7. Maintain a visible activity timeline, per-tool approval, pause, and emergency stop.
8. Keep irreversible/external actions (payment, send, deploy, delete, publish) behind fresh confirmation.

## Electron preload format

The main process is built as ESM. The preload is emitted as a single CommonJS `.cjs` bundle because Electron's sandboxed preload loader does not support ESM imports. The preload stays sandboxed and exposes only the narrow `contextBridge` API above.
