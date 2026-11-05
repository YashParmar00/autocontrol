import { describe, expect, it } from 'vitest'
import { decide, isAutonomyMode } from '../src/main/permission-engine'
import type { ActionCategory } from '../src/shared/contracts'

describe('permission engine', () => {
  it('lets every mode read the project', () => {
    expect(decide('read_project', 'guide')).toBe('allow')
    expect(decide('read_project', 'supervised')).toBe('allow')
    expect(decide('read_project', 'autonomous')).toBe('allow')
  })

  it('guide mode never changes anything', () => {
    for (const category of ['edit_code', 'run_command', 'submit_form', 'send_message', 'deploy_production'] as const) {
      expect(decide(category, 'guide')).toBe('deny')
    }
  })

  it('supervised mode asks before edits; autonomous edits but still asks for external actions', () => {
    expect(decide('edit_code', 'supervised')).toBe('ask')
    expect(decide('edit_code', 'autonomous')).toBe('allow')
    expect(decide('send_message', 'autonomous')).toBe('ask')
    expect(decide('deploy_production', 'autonomous')).toBe('ask')
  })

  it('payments are never automated in any mode', () => {
    expect(decide('payment', 'guide')).toBe('deny')
    expect(decide('payment', 'supervised')).toBe('deny')
    expect(decide('payment', 'autonomous')).toBe('deny')
  })

  it('fails closed for unknown categories and validates modes', () => {
    expect(decide('format_disk' as ActionCategory, 'autonomous')).toBe('deny')
    expect(isAutonomyMode('autonomous')).toBe(true)
    expect(isAutonomyMode('root')).toBe(false)
  })
})
