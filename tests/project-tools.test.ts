import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectProject } from '../src/main/project-service'
import { isSensitivePath, listProjectFiles, readProjectFile, searchProject } from '../src/main/project-tools'
import { buildContext, extractKeywords, rankRelevantFiles } from '../src/main/context-builder'
import type { ProjectSummary } from '../src/shared/contracts'

let root: string
let outside: string
let project: ProjectSummary

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dc-tools-'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'dc-outside-'))
  await mkdir(path.join(root, 'src', 'payments'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { express: '^5' }, scripts: { dev: 'node server.js' } }))
  await writeFile(path.join(root, 'README.md'), '# Shop\nA small store.')
  await writeFile(path.join(root, 'src', 'payments', 'razorpay.ts'), 'const key_id = process.env.RAZORPAY_KEY_ID\nexport function createOrder() {}\nconst api_key = "rzp_test_abcdefgh12345678"\n')
  await writeFile(path.join(root, '.env'), 'RAZORPAY_KEY_SECRET=super-secret-value')
  await writeFile(path.join(root, '.env.example'), 'RAZORPAY_KEY_ID=')
  await writeFile(path.join(outside, 'stolen.txt'), 'outside project')
  try { await symlink(path.join(outside, 'stolen.txt'), path.join(root, 'link.txt')) } catch { /* symlinks may be unavailable */ }
  project = await inspectProject(root)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('safe project tools', () => {
  it('flags secret paths but allows example env files', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('config/.env.production')).toBe(true)
    expect(isSensitivePath('keys/server.pem')).toBe(true)
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('.env.example')).toBe(false)
    expect(isSensitivePath('src/app.ts')).toBe(false)
  })

  it('reads normal files and redacts inline secrets', async () => {
    const content = await readProjectFile(root, 'src/payments/razorpay.ts')
    expect(content).toContain('createOrder')
    expect(content).not.toContain('rzp_test_abcdefgh12345678')
  })

  it('blocks .env, path traversal, absolute paths and symlink escapes', async () => {
    await expect(readProjectFile(root, '.env')).rejects.toThrow(/protected/)
    await expect(readProjectFile(root, '../' + path.basename(outside) + '/stolen.txt')).rejects.toThrow(/outside/)
    await expect(readProjectFile(root, path.join(outside, 'stolen.txt'))).rejects.toThrow()
    await expect(readProjectFile(root, 'link.txt')).rejects.toThrow()
  })

  it('searches code without leaking secrets', async () => {
    const result = await searchProject(root, project, 'razorpay')
    expect(result).toContain('src/payments/razorpay.ts')
    expect(result).not.toContain('super-secret-value')
    expect(listProjectFiles(project, 'src')).toContain('src/payments/razorpay.ts')
  })
})

describe('context builder', () => {
  it('extracts useful keywords from Hinglish questions', () => {
    expect(extractKeywords('Razorpay integrate karna hai mujhe')).toEqual(['razorpay', 'integrate', 'karna'])
  })

  it('ranks files that match the question', () => {
    expect(rankRelevantFiles(project, 'razorpay setup kaise kare')[0]).toBe('src/payments/razorpay.ts')
  })

  it('builds a prompt with project facts and relevant files but no secrets', async () => {
    const { systemPrompt, includedFiles } = await buildContext({ project, notes: [], mode: 'guide', userMessage: 'razorpay webhook', toolsEnabled: true })
    expect(systemPrompt).toContain('Active project: shop')
    expect(systemPrompt).toContain('GUIDE mode')
    expect(includedFiles).toContain('src/payments/razorpay.ts')
    expect(systemPrompt).not.toContain('super-secret-value')
    expect(systemPrompt).not.toContain('rzp_test_abcdefgh12345678')
  })
})
