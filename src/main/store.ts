import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectSummary, TaskNote } from '../shared/contracts'

type StoreShape = {
  schemaVersion: 1
  activeProject: ProjectSummary | null
  notes: TaskNote[]
}

const EMPTY_STORE: StoreShape = {
  schemaVersion: 1,
  activeProject: null,
  notes: [],
}

let cache: StoreShape | null = null
let writeQueue: Promise<void> = Promise.resolve()

function storePath(): string {
  return path.join(app.getPath('userData'), 'memory.json')
}

async function load(): Promise<StoreShape> {
  if (cache) return cache
  const file = storePath()
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    cache = {
      schemaVersion: 1,
      activeProject: parsed.activeProject ?? null,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[store] Could not read local memory; starting with an empty store.', error)
    }
    cache = structuredClone(EMPTY_STORE)
  }
  return cache
}

async function persist(data: StoreShape): Promise<void> {
  const file = storePath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

function enqueuePersist(data: StoreShape): Promise<void> {
  writeQueue = writeQueue.then(() => persist(data)).catch((error) => {
    console.error('[store] Could not persist local memory.', error)
  })
  return writeQueue
}

export async function getStoreSnapshot(): Promise<StoreShape> {
  const data = await load()
  return structuredClone(data)
}

export async function setActiveProject(project: ProjectSummary): Promise<void> {
  const data = await load()
  data.activeProject = project
  await enqueuePersist(data)
}

export async function addTaskNote(projectPath: string, text: string): Promise<TaskNote> {
  const data = await load()
  const note: TaskNote = {
    id: crypto.randomUUID(),
    projectPath,
    text,
    createdAt: new Date().toISOString(),
    completed: false,
  }
  data.notes.unshift(note)
  data.notes = data.notes.slice(0, 100)
  await enqueuePersist(data)
  return note
}

export async function toggleTaskNote(id: string): Promise<TaskNote[]> {
  const data = await load()
  data.notes = data.notes.map((note) => note.id === id ? { ...note, completed: !note.completed } : note)
  await enqueuePersist(data)
  return structuredClone(data.notes)
}
