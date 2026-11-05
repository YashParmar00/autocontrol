import type { ActionCategory, AutonomyMode, PermissionDecision } from '../shared/contracts'

/**
 * Central permission policy. Every tool call the AI makes is routed through `decide()`.
 * The model never gets a capability that is not listed here.
 *
 *            guide     supervised   autonomous
 * read        allow     allow        allow
 * edit/tests  deny      ask          allow
 * external    deny      ask          ask        (forms, messages, installs, db, deploy)
 * payment     deny      deny         deny       (always done by the human)
 */
const POLICY: Record<ActionCategory, Record<AutonomyMode, PermissionDecision>> = {
  read_project:      { guide: 'allow', supervised: 'allow', autonomous: 'allow' },
  analyze_screen:    { guide: 'allow', supervised: 'allow', autonomous: 'allow' },
  read_terminal:     { guide: 'allow', supervised: 'allow', autonomous: 'allow' },
  edit_code:         { guide: 'deny',  supervised: 'ask',   autonomous: 'allow' },
  run_tests:         { guide: 'deny',  supervised: 'ask',   autonomous: 'allow' },
  run_command:       { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  install_package:   { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  modify_database:   { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  submit_form:       { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  send_message:      { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  deploy_production: { guide: 'deny',  supervised: 'ask',   autonomous: 'ask' },
  payment:           { guide: 'deny',  supervised: 'deny',  autonomous: 'deny' },
}

export const AUTONOMY_MODES: AutonomyMode[] = ['guide', 'supervised', 'autonomous']

export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return typeof value === 'string' && (AUTONOMY_MODES as string[]).includes(value)
}

export function decide(category: ActionCategory, mode: AutonomyMode): PermissionDecision {
  const row = POLICY[category]
  // Unknown category → deny. Fail closed.
  return row ? row[mode] : 'deny'
}

/** Human-readable description used in the system prompt so the model knows its limits. */
export function describeMode(mode: AutonomyMode): string {
  switch (mode) {
    case 'guide':
      return 'GUIDE mode: you may read project files to understand context, but you must not change anything. Explain the next steps; the developer performs every action.'
    case 'supervised':
      return 'SUPERVISED mode: you may read project files freely. Any change (edit, run, install, submit) must be proposed and approved by the developer first.'
    case 'autonomous':
      return 'AUTONOMOUS mode: you may read and make local project changes on your own. External, destructive, deployment and financial actions still require the developer\'s explicit approval.'
  }
}
