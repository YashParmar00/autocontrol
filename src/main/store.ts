import { app } from 'electron'
import initSqlJs from 'sql.js'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssistantSettings, AuditEntry, CheckpointEntry, AutonomyMode, ChatMessage, ProjectSummary, TaskNote } from '../shared/contracts'

const require = createRequire(import.meta.url)
type Database = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>
let databasePromise: Promise<Database> | null = null
let writeQueue: Promise<void> = Promise.resolve()

function databasePath(): string {
  return path.join(app.getPath('userData'), 'memory.sqlite')
}

async function getDatabase(): Promise<Database> {
  if (databasePromise) return databasePromise
  databasePromise = (async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    })
    let database: Database
    try {
      const bytes = await readFile(databasePath())
      database = new SQL.Database(new Uint8Array(bytes))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[store] Existing local database could not be opened; creating a fresh database.', error)
      }
      database = new SQL.Database()
    }
    database.run('PRAGMA foreign_keys = ON')
    database.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    database.run(`CREATE TABLE IF NOT EXISTS projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    database.run(`CREATE TABLE IF NOT EXISTS task_notes (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_path) REFERENCES projects(path) ON DELETE CASCADE
    )`)
    database.run('CREATE INDEX IF NOT EXISTS idx_task_notes_project_created ON task_notes(project_path, created_at DESC)')
    database.run(`CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      tool_trace TEXT,
      created_at TEXT NOT NULL
    )`)
    database.run('CREATE INDEX IF NOT EXISTS idx_chat_project_created ON chat_messages(project_path, created_at)')
    database.run(`CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      project_path TEXT NOT NULL,
      file TEXT NOT NULL,
      tool TEXT NOT NULL,
      previous_content TEXT,
      restored INTEGER NOT NULL DEFAULT 0
    )`)
    database.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      category TEXT NOT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL,
      decision TEXT NOT NULL,
      outcome TEXT NOT NULL
    )`)
    return database
  })()
  return databasePromise
}

async function persistDatabase(database: Database): Promise<void> {
  const file = databasePath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, Buffer.from(database.export()), { mode: 0o600 })
  await rename(temp, file)
}

async function persistSoon(): Promise<void> {
  const database = await getDatabase()
  writeQueue = writeQueue.then(() => persistDatabase(database)).catch((error) => {
    console.error('[store] Could not persist local SQLite memory.', error)
  })
  await writeQueue
}

function firstRow<T>(database: Database, query: string, values: Array<string | number | null> = []): T | null {
  const statement = database.prepare(query)
  try {
    statement.bind(values)
    return statement.step() ? statement.getAsObject() as T : null
  } finally {
    statement.free()
  }
}

function allRows<T>(database: Database, query: string, values: Array<string | number | null> = []): T[] {
  const statement = database.prepare(query)
  const rows: T[] = []
  try {
    statement.bind(values)
    while (statement.step()) rows.push(statement.getAsObject() as T)
  } finally {
    statement.free()
  }
  return rows
}

export async function getStoreSnapshot(): Promise<{ activeProject: ProjectSummary | null; notes: TaskNote[] }> {
  const database = await getDatabase()
  const setting = firstRow<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', ['active_project_path'])
  const projectRow = setting
    ? firstRow<{ payload_json: string }>(database, 'SELECT payload_json FROM projects WHERE path = ?', [setting.value])
    : null
  const activeProject = projectRow ? JSON.parse(projectRow.payload_json) as ProjectSummary : null
  const noteRows = allRows<{ id: string; project_path: string; text: string; created_at: string; completed: number }>(
    database,
    'SELECT id, project_path, text, created_at, completed FROM task_notes ORDER BY created_at DESC LIMIT 200',
  )
  const notes = noteRows.map((row) => ({
    id: row.id,
    projectPath: row.project_path,
    text: row.text,
    createdAt: row.created_at,
    completed: row.completed === 1,
  }))
  return { activeProject, notes }
}

export async function setActiveProject(project: ProjectSummary): Promise<void> {
  const database = await getDatabase()
  database.run(
    `INSERT INTO projects(path, name, payload_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       name = excluded.name,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
    [project.path, project.name, JSON.stringify(project), new Date().toISOString()],
  )
  database.run('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', ['active_project_path', project.path])
  await persistSoon()
}

export async function addTaskNote(projectPath: string, text: string): Promise<TaskNote> {
  const database = await getDatabase()
  const note: TaskNote = {
    id: crypto.randomUUID(),
    projectPath,
    text,
    createdAt: new Date().toISOString(),
    completed: false,
  }
  database.run(
    'INSERT INTO task_notes(id, project_path, text, created_at, completed) VALUES (?, ?, ?, ?, 0)',
    [note.id, note.projectPath, note.text, note.createdAt],
  )
  await persistSoon()
  return note
}

export async function toggleTaskNote(id: string): Promise<TaskNote[]> {
  const database = await getDatabase()
  database.run('UPDATE task_notes SET completed = CASE completed WHEN 1 THEN 0 ELSE 1 END WHERE id = ?', [id])
  await persistSoon()
  const rows = allRows<{ id: string; project_path: string; text: string; created_at: string; completed: number }>(
    database,
    'SELECT id, project_path, text, created_at, completed FROM task_notes ORDER BY created_at DESC LIMIT 200',
  )
  return rows.map((row) => ({
    id: row.id,
    projectPath: row.project_path,
    text: row.text,
    createdAt: row.created_at,
    completed: row.completed === 1,
  }))
}

// ---------------------------------------------------------------------------
// v0.2.0 — assistant settings, chat history, audit log
// ---------------------------------------------------------------------------

const NO_PROJECT_KEY = '__no_project__'

function getSetting(database: Database, key: string): string | null {
  return firstRow<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', [key])?.value ?? null
}

export async function getAssistantSettings(): Promise<AssistantSettings> {
  const database = await getDatabase()
  const mode = getSetting(database, 'assistant_mode')
  return {
    model: getSetting(database, 'assistant_model'),
    mode: mode === 'guide' || mode === 'autonomous' ? mode : 'supervised',
  }
}

export async function updateAssistantSettings(patch: { model?: string | null; mode?: AutonomyMode }): Promise<AssistantSettings> {
  const database = await getDatabase()
  if (patch.model !== undefined) {
    if (patch.model) database.run('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', ['assistant_model', patch.model])
    else database.run('DELETE FROM settings WHERE key = ?', ['assistant_model'])
  }
  if (patch.mode) database.run('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', ['assistant_mode', patch.mode])
  await persistSoon()
  return getAssistantSettings()
}

export async function getChatHistory(projectPath: string | null, limit = 100): Promise<ChatMessage[]> {
  const database = await getDatabase()
  const rows = allRows<{ id: string; project_path: string; role: 'user' | 'assistant'; content: string; tool_trace: string | null; created_at: string }>(
    database,
    `SELECT * FROM (SELECT id, project_path, role, content, tool_trace, created_at FROM chat_messages
      WHERE project_path = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`,
    [projectPath ?? NO_PROJECT_KEY, limit],
  )
  return rows.map((row) => ({
    id: row.id,
    projectPath: row.project_path,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    toolTrace: row.tool_trace ? JSON.parse(row.tool_trace) as string[] : undefined,
  }))
}

export async function addChatMessage(projectPath: string | null, role: 'user' | 'assistant', content: string, toolTrace?: string[]): Promise<ChatMessage> {
  const database = await getDatabase()
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    projectPath: projectPath ?? NO_PROJECT_KEY,
    role,
    content,
    createdAt: new Date().toISOString(),
    toolTrace: toolTrace?.length ? toolTrace : undefined,
  }
  database.run(
    'INSERT INTO chat_messages(id, project_path, role, content, tool_trace, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [message.id, message.projectPath, role, content, message.toolTrace ? JSON.stringify(message.toolTrace) : null, message.createdAt],
  )
  await persistSoon()
  return message
}

export async function clearChatHistory(projectPath: string | null): Promise<void> {
  const database = await getDatabase()
  database.run('DELETE FROM chat_messages WHERE project_path = ?', [projectPath ?? NO_PROJECT_KEY])
  await persistSoon()
}

export async function addAuditEntry(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
  const database = await getDatabase()
  const full: AuditEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry }
  database.run(
    'INSERT INTO audit_log(id, at, category, tool, summary, decision, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [full.id, full.at, full.category, full.tool, full.summary, full.decision, full.outcome],
  )
  // Keep the log bounded.
  database.run('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT 1000)')
  await persistSoon()
  return full
}

export async function getAuditLog(limit = 200): Promise<AuditEntry[]> {
  const database = await getDatabase()
  return allRows<AuditEntry>(database, 'SELECT id, at, category, tool, summary, decision, outcome FROM audit_log ORDER BY at DESC LIMIT ?', [limit])
}

// ---------------------------------------------------------------------------
// v0.3.0 — checkpoints (undo for every AI file write)
// ---------------------------------------------------------------------------

type CheckpointRow = { id: string; at: string; project_path: string; file: string; tool: string; previous_content: string | null; restored: number }

function toCheckpoint(row: CheckpointRow): CheckpointEntry {
  return { id: row.id, at: row.at, projectPath: row.project_path, file: row.file, tool: row.tool, created: row.previous_content === null, restored: row.restored === 1 }
}

export async function addCheckpoint(projectPath: string, file: string, tool: string, previousContent: string | null): Promise<CheckpointEntry> {
  const database = await getDatabase()
  const row: CheckpointRow = { id: crypto.randomUUID(), at: new Date().toISOString(), project_path: projectPath, file, tool, previous_content: previousContent, restored: 0 }
  database.run('INSERT INTO checkpoints(id, at, project_path, file, tool, previous_content, restored) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [row.id, row.at, row.project_path, row.file, row.tool, row.previous_content])
  database.run('DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY at DESC LIMIT 500)')
  await persistSoon()
  return toCheckpoint(row)
}

export async function getCheckpoint(id: string): Promise<(CheckpointEntry & { previousContent: string | null }) | null> {
  const database = await getDatabase()
  const row = firstRow<CheckpointRow>(database, 'SELECT * FROM checkpoints WHERE id = ?', [id])
  return row ? { ...toCheckpoint(row), previousContent: row.previous_content } : null
}

export async function markCheckpointRestored(id: string): Promise<void> {
  const database = await getDatabase()
  database.run('UPDATE checkpoints SET restored = 1 WHERE id = ?', [id])
  await persistSoon()
}

export async function listCheckpoints(projectPath: string | null, limit = 100): Promise<CheckpointEntry[]> {
  if (!projectPath) return []
  const database = await getDatabase()
  return allRows<CheckpointRow>(database, 'SELECT * FROM checkpoints WHERE project_path = ? ORDER BY at DESC LIMIT ?', [projectPath, limit]).map(toCheckpoint)
}
