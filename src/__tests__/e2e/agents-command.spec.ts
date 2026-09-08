import { execFileSync, spawnSync } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')

describe('compiled sf agents commands', () => {
  let project: string
  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'pipe' })
  })
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'sf-agents-cli-'))
    await writeFile(
      join(project, '.saasfoundry.json'),
      JSON.stringify({ version: 'test', projectName: 'agents-demo', generatedAt: '2026-09-08', structure: 'cli', modules: { harness: { version: 1 } } })
    )
    execFileSync(
      process.execPath,
      [
        '-e',
        "require(process.argv[1]).installHarness({targetPath:process.cwd(),projectName:'agents-demo',version:'test'}).catch(e=>{console.error(e);process.exitCode=1})",
        join(ROOT, 'dist/installers/harness.installer.js')
      ],
      { cwd: project, stdio: 'pipe' }
    )
  })
  afterEach(async () => rm(project, { recursive: true, force: true }))
  function run(...args: string[]) {
    return spawnSync(process.execPath, [join(ROOT, 'bin/sf.js'), 'agents', ...args], { cwd: project, encoding: 'utf8' })
  }
  it('enables agents additively and refreshes without changing the legacy instructions or manifest again', async () => {
    const claude = await readFile(join(project, 'CLAUDE.md'), 'utf8')
    for (const agent of ['codex', 'kimi', 'claude-code']) {
      const result = run('enable', agent, '--scope', 'shared', '--json')
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).report.conflicts).toEqual([])
    }
    const inventory = JSON.parse(run('list', '--json').stdout)
    expect(inventory.configuredAgents.sort()).toEqual(['claude-code', 'codex', 'kimi'])
    expect(inventory.runtime).toBe('not-checked')
    const manifest = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    expect(run('enable', 'codex', '--scope', 'shared').status).toBe(0)
    expect(run('refresh', '--scope', 'shared').status).toBe(0)
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe(claude)
  })
  it.each([
    ['enable', 'codex'],
    ['enable', 'gpt', '--scope', 'shared'],
    ['enable', 'codex', '--scope', 'local'],
    ['enable', 'codex', '--scope', 'shared', '--unknown']
  ])('rejects unsupported or incomplete invocation without depositing files: %j', async (...args: string[]) => {
    const manifest = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    expect(run(...args).status).not.toBe(0)
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifest)
    await expect(readFile(join(project, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('reports a customized destination as a conflict instead of claiming successful activation', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Personal agent instructions\n')
    const result = run('enable', 'codex', '--scope', 'shared', '--json')
    expect(result.status).not.toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.report.conflicts).toContain('AGENTS.md')
    expect(report.configuredAgents).not.toContain('codex')
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('# Personal agent instructions\n')
  })
})
