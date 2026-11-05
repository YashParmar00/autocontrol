import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProject } from '../src/main/project-service'

let tempDirectory: string | undefined

afterEach(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
  tempDirectory = undefined
})

describe('project inspection', () => {
  it('detects common stack metadata but skips secret and generated files', async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'dev-companion-test-'))
    await mkdir(path.join(tempDirectory, 'node_modules', 'react'), { recursive: true })
    await mkdir(path.join(tempDirectory, '.git'), { recursive: true })
    await mkdir(path.join(tempDirectory, 'src'), { recursive: true })
    await writeFile(path.join(tempDirectory, 'package.json'), JSON.stringify({
      name: 'sample-shop',
      dependencies: { react: '^19.0.0', express: '^5.0.0', '@prisma/client': '^6.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    }))
    await writeFile(path.join(tempDirectory, '.env'), 'API_KEY=not-a-real-secret')
    await writeFile(path.join(tempDirectory, '.env.local'), 'TOKEN=not-a-real-secret')
    await writeFile(path.join(tempDirectory, 'private.pem'), 'not-a-real-private-key')
    await writeFile(path.join(tempDirectory, 'src', 'main.ts'), 'export const ok = true')
    await writeFile(path.join(tempDirectory, 'node_modules', 'react', 'index.js'), 'generated')
    await writeFile(path.join(tempDirectory, '.git', 'config'), 'generated')

    const result = await inspectProject(tempDirectory)
    const paths = result.files.map((file) => file.relativePath)

    expect(result.name).toBe('sample-shop')
    expect(result.detectedStack).toEqual(expect.arrayContaining(['React', 'Express', 'Prisma Client', 'TypeScript']))
    expect(result.scripts).toEqual(['dev', 'build'])
    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('.env.local')
    expect(paths).not.toContain('private.pem')
    expect(paths.some((value) => value.startsWith('node_modules/'))).toBe(false)
    expect(paths.some((value) => value.startsWith('.git/'))).toBe(false)
  })
})
