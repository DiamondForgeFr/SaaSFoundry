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
  ])('rejects invalid input or local setup without Git before depositing files: %j', async (...args: string[]) => {
    const manifest = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    const agentsInstructions = await readFile(join(project, 'AGENTS.md'), 'utf8')
    expect(run(...args).status).not.toBe(0)
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe(agentsInstructions)
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
  function succeeds(...args: string[]) {
    const result = run(...args)
    if (result.status !== 0) throw new Error(`sf agents ${args.join(' ')} failed: ${result.stderr}${result.stdout}`)
    return result
  }
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
  }
  function initializeGit() {
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Initial harness')
  }
  it('defaults to local, keeps the tracked tree clean, and exposes shared promotion in Git', async () => {
    initializeGit()
    const manifest = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    const branch = git('symbolic-ref', 'HEAD')
    const result = succeeds('enable', 'codex', '--json')
    expect(result.status).toBe(0)
    const inventory = JSON.parse(run('list', '--json').stdout)
    expect(inventory.localAgents).toContain('codex')
    expect(inventory.sharedAgents).toEqual(['claude-code'])
    expect(git('status', '--porcelain')).toBe('')
    expect(git('diff', '--cached')).toBe('')
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifest)
    expect(git('symbolic-ref', 'HEAD')).toBe(branch)
    expect(run('refresh').status).toBe(0)
    expect(run('enable', 'codex', '--scope', 'shared').status).toBe(0)
    expect(git('status', '--porcelain', '--untracked-files=all')).toContain('.agents/skills/')
    expect(git('status', '--porcelain', '--untracked-files=all')).toContain('.saasfoundry.json')
    expect(JSON.parse(run('list', '--json').stdout).sharedAgents).toContain('codex')
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Share agent support')
    const clone = project + '-clone'
    try {
      git('clone', '-q', project, clone)
      const cloned = spawnSync(process.execPath, [join(ROOT, 'bin/sf.js'), 'agents', 'list', '--json'], { cwd: clone, encoding: 'utf8' })
      expect(cloned.status).toBe(0)
      expect(JSON.parse(cloned.stdout).sharedAgents).toContain('codex')
      expect(JSON.parse(cloned.stdout).localAgents).toEqual([])
      expect(await readFile(join(clone, 'AGENTS.md'), 'utf8')).toContain('SaaSFoundry agent instructions')
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  })
  it('replaces the local declaration while preserving private adapter artifacts', async () => {
    initializeGit()
    expect(run('enable', 'gemini-cli', '--json').status).toBe(0)

    const result = run('replace', 'codex', '--json')

    expect(result.status).toBe(0)
    const inventory = JSON.parse(run('list', '--json').stdout)
    expect(inventory.localAgents).toEqual(['codex'])
    expect(inventory.configuredAgents).toEqual(['claude-code', 'codex'])
    expect(git('status', '--porcelain')).toBe('')
    expect(run('refresh').status).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
  })
  it('replaces the shared declaration without deleting prior generated adapters', async () => {
    expect(run('enable', 'gemini-cli', '--scope', 'shared').status).toBe(0)
    const gemini = await readFile(join(project, 'GEMINI.md'), 'utf8')

    const result = run('replace', 'kimi', '--scope', 'shared', '--json')

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).sharedAgents).toEqual(['kimi'])
    expect(JSON.parse(await readFile(join(project, '.saasfoundry.json'), 'utf8')).modules.harness.agents).toEqual(['kimi'])
    expect(await readFile(join(project, 'GEMINI.md'), 'utf8')).toBe(gemini)
  })
  it('refuses a tracked instruction conflict before changing any project file', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Team rules\n')
    initializeGit()
    const manifest = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    expect(run('enable', 'codex').status).not.toBe(0)
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('# Team rules\n')
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifest)
  })
  it('isolates local choices and exclusions between linked worktrees', async () => {
    initializeGit()
    const sibling = project + '-sibling'
    try {
      git('worktree', 'add', '-qb', 'sibling', sibling)
      succeeds('enable', 'codex')
      const siblingInventory = spawnSync(process.execPath, [join(ROOT, 'bin/sf.js'), 'agents', 'list', '--json'], { cwd: sibling, encoding: 'utf8' })
      expect(siblingInventory.status).toBe(0)
      expect(JSON.parse(siblingInventory.stdout).localAgents).toEqual([])
      await writeFile(join(sibling, 'AGENTS.md'), '# Unrelated sibling instructions\n')
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: sibling, encoding: 'utf8' })).toContain('AGENTS.md')
      expect(git('status', '--porcelain')).toBe('')
    } finally {
      git('worktree', 'remove', '--force', sibling)
    }
  })
  it('lists the versioned catalog without requiring a managed project or writing files', async () => {
    const agentsInstructions = await readFile(join(project, 'AGENTS.md'), 'utf8')
    await rm(join(project, '.saasfoundry.json'))
    const result = run('catalog', '--json')
    expect(result.status).toBe(0)
    const catalog = JSON.parse(result.stdout)
    expect(catalog.registryVersion).toBe(1)
    expect(catalog.runtime).toBe('not-checked')
    expect(catalog.profiles.map((profile: { id: string }) => profile.id)).toEqual(expect.arrayContaining(['gemini-cli', 'qwen-code', 'generic']))
    expect(catalog.profiles.every((profile: { runtime: string }) => profile.runtime === 'not-checked')).toBe(true)
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe(agentsInstructions)
  })
  it('enables registry profiles without coupling instructions to a model or provider', async () => {
    for (const agent of ['gemini-cli', 'qwen-code', 'generic']) {
      const result = run('enable', agent, '--scope', 'shared', '--json')
      if (result.status !== 0) throw new Error(result.stdout + result.stderr)
    }
    expect(await readFile(join(project, 'GEMINI.md'), 'utf8')).toContain('@AGENTS.md')
    const before = await readFile(join(project, '.saasfoundry.json'), 'utf8')
    expect(JSON.parse(run('list', '--json').stdout).configuredAgents).toEqual(expect.arrayContaining(['claude-code', 'gemini-cli', 'qwen-code', 'generic']))
    expect(run('refresh', '--scope', 'shared').status).toBe(0)
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(before)
    expect(run('enable', 'deepseek', '--scope', 'shared').status).not.toBe(0)
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(before)
  })
})
