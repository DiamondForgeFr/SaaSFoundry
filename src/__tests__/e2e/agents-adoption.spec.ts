import { execFileSync, spawnSync } from 'child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')
const CLI = join(ROOT, 'bin/sf.js')

describe('compiled sf agents adopt command', () => {
  let project: string

  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'pipe' })
  })

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'sf-agents-adopt-'))
  })

  afterEach(async () => rm(project, { recursive: true, force: true }))

  function run(...args: string[]) {
    return spawnSync(process.execPath, [CLI, 'agents', 'adopt', ...args], { cwd: project, encoding: 'utf8' })
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
  }

  async function writeManifest(): Promise<void> {
    await writeFile(join(project, '.saasfoundry.json'), JSON.stringify({ version: 'test', projectName: 'adoption-demo', generatedAt: '2026-09-08', structure: 'cli' }, null, 2) + '\n')
  }

  async function preview(agents: string[], scope: 'local' | 'shared' = 'local', mode: 'add' | 'replace' = 'add') {
    const result = run(...agents, '--scope', scope, '--mode', mode, '--json')
    if (result.status !== 0) throw new Error(result.stderr + result.stdout)
    return JSON.parse(result.stdout) as { planId: string; canApply: boolean; source: string; conflicts: string[]; prerequisites: string[] }
  }

  it('previews without a manifest and leaves the repository and Git configuration byte-for-byte untouched', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Existing Codex instructions\n')
    git('init', '-q')
    const configBefore = await readFile(join(project, '.git/config'))
    const entriesBefore = await readdir(project)

    const result = run('codex', '--json')

    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan.source).toBe('codex')
    expect(plan.canApply).toBe(false)
    expect(plan.prerequisites.join('\n')).toContain('sf workflow')
    const text = run('codex')
    expect(text.status).toBe(0)
    expect(text.stdout).toContain('Source: codex')
    expect(text.stdout).toContain('Prerequisites:')
    expect(text.stdout).toContain('Warnings:')
    expect(await readdir(project)).toEqual(entriesBefore)
    expect(await readFile(join(project, '.git/config'))).toEqual(configBefore)
    expect(git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()).toEqual(['?? AGENTS.md'])
  })

  it('requires a plan for apply and rejects a stale plan before writing', async () => {
    await writeManifest()
    await writeFile(join(project, 'CLAUDE.md'), '# Existing Claude instructions\n')
    const plan = await preview(['codex'], 'shared')
    expect(plan.canApply).toBe(true)

    const missing = run('codex', '--scope', 'shared', '--apply', '--json')
    expect(missing.status).not.toBe(0)
    expect(JSON.parse(missing.stdout).error).toContain('--apply --plan')

    await writeFile(join(project, 'CLAUDE.md'), '# Changed after review\n')
    const stale = run('codex', '--scope', 'shared', '--apply', '--plan', plan.planId, '--json')
    expect(stale.status).not.toBe(0)
    expect(JSON.parse(stale.stdout).error).toContain('stale')
    await expect(readFile(join(project, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adopts a Codex-first repository for Claude in shared scope without replacing AGENTS.md', async () => {
    await writeManifest()
    const original = '# Existing Codex instructions\n\nUse the project checks.\n'
    await writeFile(join(project, 'AGENTS.md'), original)
    const plan = await preview(['codex', 'claude-code'], 'shared')
    expect(plan.source).toBe('codex')
    expect(plan.canApply).toBe(true)

    const applied = run('codex', 'claude-code', '--scope', 'shared', '--apply', '--plan', plan.planId, '--json')
    expect(applied.status).toBe(0)
    expect(JSON.parse(applied.stdout).sharedAgents).toEqual(expect.arrayContaining(['codex', 'claude-code']))
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe(original)
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
    expect(JSON.parse(await readFile(join(project, '.saasfoundry.json'), 'utf8')).modules.harness.agents).toEqual(expect.arrayContaining(['codex', 'claude-code']))
  })
  it('binds replacement mode into the reviewed plan and applies an exact shared declaration', async () => {
    await writeManifest()
    await writeFile(join(project, 'CLAUDE.md'), '# Existing Claude instructions\n')
    const add = await preview(['codex'], 'shared')
    const replace = await preview(['codex'], 'shared', 'replace')
    expect(replace.planId).not.toBe(add.planId)

    const applied = run('codex', '--scope', 'shared', '--mode', 'replace', '--apply', '--plan', replace.planId, '--json')

    expect(applied.status).toBe(0)
    expect(JSON.parse(applied.stdout).sharedAgents).toEqual(['codex'])
    expect(JSON.parse(await readFile(join(project, '.saasfoundry.json'), 'utf8')).modules.harness.agents).toEqual(['codex'])
  })

  it('adopts locally without modifying tracked files or exposing generated files to Git', async () => {
    await writeManifest()
    const original = '# Existing Codex instructions\n'
    await writeFile(join(project, 'AGENTS.md'), original)
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Existing project')
    const plan = await preview(['codex', 'claude-code'])
    expect(plan.canApply).toBe(true)

    const applied = run('codex', 'claude-code', '--apply', '--plan', plan.planId, '--json')
    expect(applied.status).toBe(0)
    expect(JSON.parse(applied.stdout).localAgents).toEqual(expect.arrayContaining(['codex', 'claude-code']))
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe(original)
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git('diff', '--cached')).toBe('')
  })

  it('reports distinct custom Claude and Codex roots as a conflict and refuses apply without side effects', async () => {
    await writeManifest()
    await writeFile(join(project, 'CLAUDE.md'), '# Custom Claude rules\n')
    await writeFile(join(project, 'AGENTS.md'), '# Different custom Codex rules\n')
    const before = (await readdir(project)).sort()
    const plan = await preview(['codex', 'claude-code'], 'shared')
    expect(plan.source).toBe('mixed')
    expect(plan.canApply).toBe(false)
    expect(plan.conflicts).toContain('AGENTS.md')

    const result = run('codex', 'claude-code', '--scope', 'shared', '--apply', '--plan', plan.planId, '--json')
    expect(result.status).not.toBe(0)
    expect(JSON.parse(result.stdout).error).toContain('conflicts')
    expect((await readdir(project)).sort()).toEqual(before)
  })

  it('reuses an existing Claude instruction source and creates only the shared adapter', async () => {
    await writeManifest()
    const original = '# Existing managed Claude instructions\n'
    await writeFile(join(project, 'CLAUDE.md'), original)
    const text = run('claude-code', 'codex', '--scope', 'shared')
    expect(text.status).toBe(0)
    expect(text.stdout).toMatch(/Apply this exact plan: sf agents adopt claude-code codex --scope shared --apply --plan [a-f0-9]{64}/)
    const plan = await preview(['claude-code', 'codex'], 'shared')
    expect(plan.source).toBe('claude')
    expect(plan.canApply).toBe(true)

    const result = run('claude-code', 'codex', '--scope', 'shared', '--apply', '--plan', plan.planId, '--json')
    expect(result.status).toBe(0)
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe(original)
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain('Read `CLAUDE.md`')
  })
})
