import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
const projectScanner = readFileSync(path.join(process.cwd(), 'src/main/project-service.ts'), 'utf8')
const preloadSource = readFileSync(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8')

describe('starter security boundaries', () => {
  it('keeps Node integration disabled and the renderer sandboxed', () => {
    expect(mainSource).toContain('contextIsolation: true')
    expect(mainSource).toContain('nodeIntegration: false')
    expect(mainSource).toContain('sandbox: true')
    expect(mainSource).toContain('webSecurity: true')
    expect(mainSource).not.toContain('nodeIntegration: true')
  })

  it('only exposes the narrow typed preload API', () => {
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld')
    expect(preloadSource).not.toContain('require(')
    expect(preloadSource).not.toContain('child_process')
  })

  it('excludes secret-like files and skips symbolic links during project scans', () => {
    expect(projectScanner).toContain('SENSITIVE_FILE')
    expect(projectScanner).toContain('entry.isSymbolicLink()')
    expect(projectScanner).toContain('stat.isSymbolicLink()')
  })
})
