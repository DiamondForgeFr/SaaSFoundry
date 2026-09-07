import { execFileSync } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')

describe('compiled shared harness installer', () => {
  let project: string

  beforeAll(() => {
    // The E2E CI job runs independently of the build job. Exercise the shipped
    // JavaScript and resource paths, not Jest's TypeScript module loader.
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'pipe' })
  })

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'sf-agent-e2e-'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  function runInstaller(): { written: string[]; conflicts: string[] } {
    const script = `
      const { installHarness } = require(process.argv[1]);
      installHarness({ targetPath: process.cwd(), projectName: 'shared-demo', version: 'test',
        agents: ['claude-code', 'codex', 'kimi'],
        workflow: { tool: 'github-projects', workingBranch: 'develop', statuses: [{ name: 'Backlog' }, { name: 'Done' }] }
      }).then(report => process.stdout.write(JSON.stringify(report))).catch(error => { console.error(error); process.exitCode = 1; });
    `
    const output = execFileSync(process.execPath, ['-e', script, join(ROOT, 'dist/installers/harness.installer.js')], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(output)
  }

  it('discovers packaged resources from another working directory and preserves a later customization', async () => {
    expect(runInstaller().conflicts).toEqual([])
    const claude = await readFile(join(project, 'CLAUDE.md'), 'utf8')
    const shared = await readFile(join(project, '.agents/skills/sf-workflow/SKILL.md'), 'utf8')
    expect(shared).toContain('name: sf-workflow')
    expect(shared).toContain('../../../.claude/docs/manifest-schema.md')
    expect(await readFile(join(project, '.claude/docs/manifest-schema.md'), 'utf8')).not.toBe('')
    expect(runInstaller().written).toEqual([])
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe(claude)

    await writeFile(join(project, 'AGENTS.md'), '# Personal instructions\n')
    expect(runInstaller().conflicts).toContain('AGENTS.md')
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('# Personal instructions\n')
    expect(await readFile(join(project, 'AGENTS.md.saasfoundry.new'), 'utf8')).toContain('Read `CLAUDE.md`')
  })
})
