import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalBroker } from '../src/main/approvals'
import { diffLines, renderDiff } from '../src/main/diff'
import { PACKAGE_SPEC, ProcessManager, SCRIPT_NAME, installArgs } from '../src/main/process-manager'
import { planEdit, planWrite, resolveSafeForWrite } from '../src/main/project-tools'

let root: string
let outside: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dc-v030-'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'dc-v030-out-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  await writeFile(path.join(root, 'src', 'dup.ts'), 'x\nx\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 't', scripts: { hello: 'node -e "console.log(\'hi from script\'); console.error(\'TOKEN=abc12345\')"', slow: 'node -e "setTimeout(()=>{},60000)"', fail: 'node -e "process.exit(3)"' } }))
  try { await symlink(outside, path.join(root, 'escape'), 'dir') } catch { /* no symlink support */ }
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('diff', () => {
  it('produces add/remove lines', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc')!
    expect(lines.filter((l) => l.kind !== ' ')).toEqual([{ kind: '-', text: 'b' }, { kind: '+', text: 'B' }])
    expect(renderDiff('f.ts', null, 'new')).toContain('new file')
    expect(renderDiff('f.ts', 'same', 'same')).toContain('no changes')
  })
})

describe('safe writes', () => {
  it('plans edits with exact single matches only', async () => {
    const plan = await planEdit(root, 'src/a.ts', 'two', 'TWO')
    expect(plan.after).toBe('one\nTWO\nthree\n')
    expect(plan.before).toBe('one\ntwo\nthree\n')
    await expect(planEdit(root, 'src/a.ts', 'missing', 'x')).rejects.toThrow(/not found/)
    await expect(planEdit(root, 'src/dup.ts', 'x', 'y')).rejects.toThrow(/more than once/)
  })

  it('allows new files in new folders but blocks secrets, traversal and symlink escapes', async () => {
    const plan = await planWrite(root, 'src/new/dir/file.ts', 'export {}')
    expect(plan.before).toBeNull()
    await expect(resolveSafeForWrite(root, '.env.local')).rejects.toThrow(/Secret/)
    await expect(resolveSafeForWrite(root, '../evil.ts')).rejects.toThrow(/outside/)
    await expect(resolveSafeForWrite(root, 'node_modules/x/index.js')).rejects.toThrow(/dependency/)
    await expect(resolveSafeForWrite(root, 'escape/pwn.ts')).rejects.toThrow(/outside/)
    await expect(planWrite(root, 'big.txt', 'x'.repeat(600_000))).rejects.toThrow(/too large/)
  })

  it('refuses to write redaction placeholders over real secrets', async () => {
    await writeFile(path.join(root, 'src', 'config.ts'), 'export const API_KEY = "real-value-123"\n')
    await expect(planWrite(root, 'src/config.ts', 'export const API_KEY = [REDACTED]\nexport const x = 1\n')).rejects.toThrow(/placeholders/)
    await expect(planEdit(root, 'src/config.ts', 'API_KEY = [REDACTED]', 'API_KEY = "x"')).rejects.toThrow(/placeholders/)
  })
})

describe('approval broker', () => {
  it('resolves on answer, times out to false, and rejects all on stop', async () => {
    const seen: string[] = []
    const broker = new ApprovalBroker((req) => seen.push(req.id), 50)
    const first = broker.request({ requestId: 'r', tool: 't', category: 'edit_code', summary: 's', preview: 'p' })
    expect(broker.respond(seen[0], true)).toBe(true)
    await expect(first).resolves.toBe(true)
    await expect(broker.request({ requestId: 'r', tool: 't', category: 'edit_code', summary: 's', preview: 'p' })).resolves.toBe(false)
    const third = broker.request({ requestId: 'r', tool: 't', category: 'edit_code', summary: 's', preview: 'p' })
    expect(broker.rejectAll()).toBe(1)
    await expect(third).resolves.toBe(false)
  })
})

describe('process manager', () => {
  it('validates names', () => {
    expect(SCRIPT_NAME.test('test:unit')).toBe(true)
    expect(SCRIPT_NAME.test('a; rm -rf /')).toBe(false)
    expect(PACKAGE_SPEC.test('@types/node@^22')).toBe(true)
    expect(PACKAGE_SPEC.test('x|y')).toBe(false)
    expect(installArgs('Yarn', ['a'], true)).toEqual(['add', '--dev', 'a'])
    expect(installArgs(null, ['a'], false)).toEqual(['install', 'a'])
  })

  it('runs a script, captures output and redacts secrets', async () => {
    const pm = new ProcessManager()
    const result = await pm.run({ cwd: root, manager: 'npm', args: ['run', 'hello'], timeoutMs: 30_000 })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hi from script')
    expect(result.output).not.toContain('abc12345')
    const failed = await pm.run({ cwd: root, manager: 'npm', args: ['run', 'fail'], timeoutMs: 30_000 })
    expect(failed.exitCode).not.toBe(0)
  }, 40_000)

  it('kills scripts on timeout and refuses shell metacharacters', async () => {
    const pm = new ProcessManager()
    const result = await pm.run({ cwd: root, manager: 'npm', args: ['run', 'slow'], timeoutMs: 1_500 })
    expect(result.timedOut).toBe(true)
    const unsafe = await pm.run({ cwd: root, manager: 'npm', args: ['run', 'x&calc'], timeoutMs: 1_000 })
    expect(unsafe.output).toMatch(/unsafe/)
  }, 40_000)

  it('starts background processes, reads output and stops them all', async () => {
    const pm = new ProcessManager()
    const info = pm.start({ cwd: root, manager: 'npm', script: 'slow' })
    expect(pm.list()[0]).toMatchObject({ id: info.id, running: true })
    await new Promise((r) => setTimeout(r, 1_000))
    expect(pm.read(info.id)).toContain('slow')
    expect(pm.stopAll()).toBe(1)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(pm.list()[0].running).toBe(false)
  }, 20_000)
})

describe('file ops round trip (without electron store)', () => {
  it('a planned write can be applied and reverted manually', async () => {
    const plan = await planEdit(root, 'src/a.ts', 'three', 'THREE')
    await writeFile(plan.absolute, plan.after)
    expect(await readFile(plan.absolute, 'utf8')).toContain('THREE')
    await writeFile(plan.absolute, plan.before!)
    expect(await readFile(plan.absolute, 'utf8')).toBe('one\ntwo\nthree\n')
  })
})
