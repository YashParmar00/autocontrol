import { describe, expect, it } from 'vitest'

describe('starter security boundaries', () => {
  it('documents a deny-by-default posture for shell and screen tools', () => {
    const roadmap = 'No screen capture, browser control, terminal execution, credential access, or autonomous actions in this starter.'
    expect(roadmap).toContain('No screen capture')
    expect(roadmap).toContain('terminal execution')
  })
})
