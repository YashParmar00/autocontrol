import { app } from 'electron'
import initSqlJs from 'sql.js'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectSummary, TaskNote } from '../shared/contracts'

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
