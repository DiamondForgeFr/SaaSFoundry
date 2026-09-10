import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../../..')

describe('SaaSFoundryAI shared harness dogfood declaration', () => {
  it('declares Claude Code and Codex with reproducible tracked adapter baselines', async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, '.saasfoundry.json'), 'utf8'))
    expect(manifest.modules.harness.agents).toEqual(['claude-code', 'codex'])

    const agents = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Read `CLAUDE.md`')
    expect(agents).toContain('Coding-agent identity and onboarding')
    expect(await readFile(resolve(ROOT, 'GEMINI.md'), 'utf8')).toContain('@AGENTS.md')

    const baselines = manifest.fileHashes as Record<string, string>
    expect(Object.keys(baselines)).toEqual(expect.arrayContaining(['AGENTS.md', 'GEMINI.md', '.agents/skills/sf-workflow/workflow-cli.sh']))
    expect(Object.keys(baselines).some((path) => path.startsWith('.codex/'))).toBe(false)
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(tracked).toEqual(expect.arrayContaining(['AGENTS.md', 'GEMINI.md', '.agents/skills/sf-workflow/workflow-cli.sh']))
    expect(tracked.some((path) => path.startsWith('.codex/'))).toBe(false)

    for (const [path, expected] of Object.entries(baselines)) {
      const content = await readFile(resolve(ROOT, path))
      expect(createHash('sha256').update(content).digest('hex')).toBe(expected)
    }
  })

  it('keeps the portable guarded CLIs byte-identical and executable', async () => {
    for (const relative of ['sf-workflow/workflow-cli.sh', 'sf-tool-github-projects/github-projects-cli.sh']) {
      const claudePath = resolve(ROOT, '.claude/skills', relative)
      const portablePath = resolve(ROOT, '.agents/skills', relative)
      expect(await readFile(portablePath)).toEqual(await readFile(claudePath))
      expect((await stat(portablePath)).mode & 0o111).not.toBe(0)
    }
  })
})
