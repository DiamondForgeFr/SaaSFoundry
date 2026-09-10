import { readFileSync } from 'fs'
import path from 'path'

// Regression guard for #243: every CLAUDE.md shipped by a SaaSFoundryAI scaffold
// must carry the "Preconditions first" directive, and every scaffolded
// `.claude/` must ship a `settings.json` wiring a SessionStart hook that calls
// `sf status --claude-friendly`. If a new blueprint or overlay forgets either,
// generated projects will regress to re-asking scope questions already answered
// by the manifest.
const ROOT = path.resolve(__dirname, '../../../..')

const CLAUDE_MD_SCAFFOLDS = [
  path.resolve(ROOT, 'scaffolds/blueprints/api/CLAUDE.md'),
  path.resolve(ROOT, 'scaffolds/blueprints/web/CLAUDE.md'),
  path.resolve(ROOT, 'scaffolds/overlays/monorepo/root/CLAUDE.md')
]

const SETTINGS_SCAFFOLDS = [
  path.resolve(ROOT, 'scaffolds/blueprints/api/.claude/settings.json'),
  path.resolve(ROOT, 'scaffolds/blueprints/web/.claude/settings.json'),
  path.resolve(ROOT, 'scaffolds/overlays/monorepo/root/.claude/settings.json')
]

describe('Preconditions first directive (scaffold mirrors)', () => {
  it.each(CLAUDE_MD_SCAFFOLDS)('%s contains the Preconditions first section', (file) => {
    const content = readFileSync(file, 'utf8')
    expect(content).toMatch(/Preconditions first/)
    expect(content).toMatch(/\.saasfoundry\.json/)
    expect(content).toMatch(/sf status --claude-friendly/)
  })

  it.each(CLAUDE_MD_SCAFFOLDS)('%s contains the coding-agent onboarding contract', (file) => {
    const content = readFileSync(file, 'utf8')
    expect(content).toMatch(/Coding-agent identity and onboarding/)
    expect(content).toMatch(/sf agents list --json/)
    expect(content).toMatch(/sf agents enable/)
    expect(content).toMatch(/sf agents replace/)
  })

  it('repo-root CLAUDE.md contains the Preconditions first section', () => {
    const content = readFileSync(path.resolve(ROOT, 'CLAUDE.md'), 'utf8')
    expect(content).toMatch(/Preconditions first/)
    expect(content).toMatch(/\.saasfoundry\.json/)
    expect(content).toMatch(/sf status --claude-friendly/)
  })
})

describe('SessionStart hook (scaffold mirrors)', () => {
  it.each(SETTINGS_SCAFFOLDS)('%s wires a SessionStart hook calling sf status', (file) => {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessionStart = parsed?.hooks?.SessionStart
    expect(Array.isArray(sessionStart)).toBe(true)
    expect(sessionStart.length).toBeGreaterThan(0)
    const commands: string[] = sessionStart.flatMap((entry: { hooks?: Array<{ type?: string; command?: string }> }) =>
      (entry.hooks ?? []).filter((h) => h.type === 'command').map((h) => h.command ?? '')
    )
    expect(commands.some((cmd: string) => cmd.includes('sf status') && cmd.includes('--claude-friendly'))).toBe(true)
  })

  it('repo-root .claude/settings.json wires a SessionStart hook calling sf status', () => {
    const parsed = JSON.parse(readFileSync(path.resolve(ROOT, '.claude/settings.json'), 'utf8'))
    const sessionStart = parsed?.hooks?.SessionStart
    expect(Array.isArray(sessionStart)).toBe(true)
    const commands: string[] = sessionStart.flatMap((entry: { hooks?: Array<{ type?: string; command?: string }> }) =>
      (entry.hooks ?? []).filter((h) => h.type === 'command').map((h) => h.command ?? '')
    )
    expect(commands.some((cmd: string) => cmd.includes('sf status') && cmd.includes('--claude-friendly'))).toBe(true)
  })
})
