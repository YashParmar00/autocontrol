import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckpointEntry } from '../shared/contracts'
import { resolveSafeForWrite, type PlannedWrite } from './project-tools'
import { addCheckpoint, getCheckpoint, markCheckpointRestored } from './store'

/** Apply an approved write and record a checkpoint so it can be undone. */
export async function applyPlannedWrite(projectPath: string, plan: PlannedWrite, tool: string): Promise<CheckpointEntry> {
  // Re-validate right before writing (the file system may have changed while waiting for approval).
  const target = await resolveSafeForWrite(projectPath, plan.relative)
  const checkpoint = await addCheckpoint(projectPath, target.relative, tool, plan.before)
  await mkdir(path.dirname(target.absolute), { recursive: true })
  await writeFile(target.absolute, plan.after, 'utf8')
  return checkpoint
}

/** Restore the file to how it was before the AI changed it (or delete it if the AI created it). */
export async function undoCheckpoint(projectPath: string, id: string): Promise<void> {
  const checkpoint = await getCheckpoint(id)
  if (!checkpoint || checkpoint.projectPath !== projectPath) throw new Error('Checkpoint not found for this project.')
  if (checkpoint.restored) throw new Error('This change was already undone.')
  const target = await resolveSafeForWrite(projectPath, checkpoint.file)
  if (checkpoint.previousContent === null) {
    if (target.exists) await rm(target.absolute)
  } else {
    await mkdir(path.dirname(target.absolute), { recursive: true })
    await writeFile(target.absolute, checkpoint.previousContent, 'utf8')
  }
  await markCheckpointRestored(id)
}
