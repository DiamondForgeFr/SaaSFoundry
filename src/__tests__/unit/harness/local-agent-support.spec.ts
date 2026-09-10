import { execFile, execFileSync } from 'child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { promises as filesystem } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'

import { planAgentInstructions } from '../../../harness/agent-instructions'
import { enableAgents, readAgentSupport, refreshAgents, replaceAgents } from '../../../harness/agent-support'

const exec = promisify(execFile)
const manifest = { version: '1', structure: 'cli', projectName: 'local-test' }

describe('checkout-local agent support', () => {
  let root: string
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim()
  const put = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const get = (path: string) => readFile(join(root, path), 'utf8')
  const enable = (agents: string[]) => enableAgents({ targetPath: root, agents })
  const replace = (agents: string[]) => replaceAgents({ targetPath: root, agents })
  const privateState = async () => JSON.parse(await readFile(join(await git('rev-parse', '--absolute-git-dir'), 'saasfoundry/agents.json'), 'utf8'))
  const commit = async () => {
    await git('add', '.')
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture')
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-local-agents-'))
    await git('init', '-q')
    await put('.saasfoundry.json', JSON.stringify(manifest, null, 4) + '\n')
    await put('CLAUDE.md', '# Existing rules')
    await put('.claude/skills/sf-git-commit/SKILL.md', '---\nname: commit\ndescription: Commit code\n---\n# Commit\n')
    await commit()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('defaults to local, keeps manifest/index/tracked diff unchanged, and hides only local artifacts', async () => {
    const before = await get('.saasfoundry.json')
    const index = await git('ls-files', '--stage')
    const result = await enable(['codex'])
    expect(result.scope).toBe('local')
    expect(result.manifestChanged).toBe(false)
    expect(result.sharedAgents).toEqual(['claude-code'])
    expect(result.localAgents).toEqual(['codex'])
    expect(result.configuredAgents).toEqual(['claude-code', 'codex'])
    expect(await get('.saasfoundry.json')).toBe(before)
    expect(await git('ls-files', '--stage')).toBe(index)
    expect(await git('status', '--porcelain')).toBe('')
    expect((await privateState()).agents).toEqual(['codex'])
    expect(await get('AGENTS.md')).toContain('CLAUDE.md')
  })
  it('is idempotent across enable and refresh with no manifest churn', async () => {
    await enable(['codex'])
    const state = await privateState()
    const stamp = (await lstat(join(root, 'AGENTS.md'))).mtimeMs
    const result = await refreshAgents({ targetPath: root })
    expect(result.report.written).toEqual([])
    expect(result.localStateChanged).toBe(false)
    expect(await privateState()).toEqual(state)
    expect((await lstat(join(root, 'AGENTS.md'))).mtimeMs).toBe(stamp)
  })
  it('preflights later tracked conflicting skills before creating AGENTS.md or Git configuration', async () => {
    await put('.agents/skills/sf-git-commit/SKILL.md', '# Shared custom skill')
    await commit()
    const config = await get('.git/config')
    const result = await enable(['codex'])
    expect(result.report.conflicts).toEqual(['.agents/skills/sf-git-commit/SKILL.md'])
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await get('.git/config')).toBe(config)
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toBe('# Shared custom skill')
    await expect(privateState()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('borrows identical tracked files without owning hashes or excluding them', async () => {
    const plan = await planAgentInstructions({ targetPath: root, agents: ['codex'] })
    for (const file of plan.files) await put(file.path, file.content)
    await commit()
    const result = await enable(['codex'])
    expect(result.report.written).toEqual([])
    expect(result.report.conflicts).toEqual([])
    expect((await privateState()).fileHashes).toEqual({})
    expect(await git('status', '--porcelain')).toBe('')
    expect(await git('config', '--get', 'extensions.worktreeConfig').catch(() => '')).toBe('')
  })
  it('never overwrites a tracked target even when a local baseline matches', async () => {
    await enable(['codex'])
    await git('add', '-f', 'AGENTS.md', '.agents')
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'promote')
    await put('.claude/skills/sf-git-commit/SKILL.md', '# Updated common instructions')
    const before = await get('.agents/skills/sf-git-commit/SKILL.md')
    const result = await refreshAgents({ targetPath: root })
    expect(result.report.conflicts).toContain('.agents/skills/sf-git-commit/SKILL.md')
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toBe(before)
  })
  it('refuses missing tracked targets without recreating them', async () => {
    await put('AGENTS.md', '# tracked')
    await commit()
    await rm(join(root, 'AGENTS.md'))
    const result = await enable(['codex'])
    expect(result.report.conflicts).toContain('AGENTS.md')
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses user-owned untracked conflicts without sidecars or other deposits', async () => {
    await put('AGENTS.md', '# Mine')
    const config = await get('.git/config')
    const result = await enable(['codex'])
    expect(result.report.conflicts).toContain('AGENTS.md')
    expect(await get('AGENTS.md')).toBe('# Mine')
    expect(await get('.git/config')).toBe(config)
    expect(await readdir(root)).not.toContain('AGENTS.md.saasfoundry.new')
    expect(await readdir(root)).not.toContain('.agents')
  })
  it('rejects case-colliding discovery paths before mutations', async () => {
    await put('agents.md', '# Different path')
    await commit()
    const config = await get('.git/config')
    await expect(enable(['codex'])).rejects.toThrow('Case-colliding')
    expect(await get('.git/config')).toBe(config)
  })
  it.each(['120000', 'unmerged'])('refuses unsafe index entry %s even with identical disk bytes', async (mode) => {
    const plan = await planAgentInstructions({ targetPath: root, agents: ['codex'] })
    const content = plan.files.find((file) => file.path === 'AGENTS.md')!.content
    await put('AGENTS.md', content)
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: content, encoding: 'utf8' }).trim()
    if (mode === 'unmerged') execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: `100644 ${blob} 1\tAGENTS.md\n` })
    else await git('update-index', '--add', '--cacheinfo', `${mode},${blob},AGENTS.md`)
    const result = await enable(['codex'])
    expect(result.report.conflicts).toContain('AGENTS.md')
    await expect(privateState()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses tracked gitlink ancestors before creating local files', async () => {
    await mkdir(join(root, '.agents/skills'), { recursive: true })
    const head = await git('rev-parse', 'HEAD')
    await git('update-index', '--add', '--cacheinfo', `160000,${head},.agents`)
    const config = await get('.git/config')
    const result = await enable(['codex'])
    expect(result.report.conflicts).toContain('.agents/skills/sf-git-commit/SKILL.md')
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await get('.git/config')).toBe(config)
  })
  it('keeps two linked worktree inventories and discovery independent', async () => {
    const other = `${root}-other`
    await git('worktree', 'add', '-qb', 'other', other)
    try {
      await enable(['codex'])
      const inventory = await readAgentSupport(other)
      expect(inventory.localAgents).toEqual([])
      await expect(readFile(join(other, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await enableAgents({ targetPath: other, agents: ['kimi'] })
      expect((await readAgentSupport(root)).localAgents).toEqual(['codex'])
      expect((await readAgentSupport(other)).localAgents).toEqual(['kimi'])
    } finally {
      await git('worktree', 'remove', '--force', other)
    }
  })
  it('shared activation does not publish all local preferences and releases promoted exclusions', async () => {
    await enable(['codex'])
    const result = await enableAgents({ targetPath: root, agents: ['kimi'], scope: 'shared' })
    expect(result.sharedAgents).toEqual(['claude-code', 'kimi'])
    expect(result.localAgents).toEqual(['codex'])
    expect(JSON.parse(await get('.saasfoundry.json')).modules.harness.agents).toEqual(['claude-code', 'kimi'])
    expect((await privateState()).fileHashes).toEqual({})
    expect(await git('status', '--porcelain')).toContain('AGENTS.md')
  })
  it.each(['codex', 'gemini-cli'])('recovers owned %s output after final private-state persistence fails', async (agent) => {
    const actualRename = filesystem.rename
    let inventorySaves = 0
    jest.spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('/saasfoundry/agents.json') && ++inventorySaves === 2) throw new Error('Injected final inventory failure')
      return actualRename(source, destination)
    })
    await expect(enable([agent])).rejects.toThrow('Injected final inventory failure')
    expect((await privateState()).agents).toEqual([])
    expect((await privateState()).fileHashes).toEqual({})
    expect((await privateState()).pendingFileHashes['AGENTS.md']).toBeTruthy()
    jest.restoreAllMocks()
    const retry = await enable([agent])
    expect(retry.report.conflicts).toEqual([])
    expect((await privateState()).pendingFileHashes).toBeUndefined()
    await put('.claude/skills/sf-git-commit/SKILL.md', '# New source instructions')
    const refreshed = await refreshAgents({ targetPath: root })
    expect(refreshed.report.conflicts).toEqual([])
    expect(refreshed.report.written).toContain('.agents/skills/sf-git-commit/SKILL.md')
  })
  it('enables local Gemini and refreshes it idempotently with private wrapper baselines', async () => {
    const before = await get('.saasfoundry.json')
    const result = await enable(['gemini-cli'])
    expect(result.localAgents).toEqual(['gemini-cli'])
    expect(await get('GEMINI.md')).toContain('@AGENTS.md')
    expect((await privateState()).fileHashes['GEMINI.md']).toMatch(/^[0-9a-f]{64}$/)
    const repeated = await enable(['gemini-cli'])
    expect(repeated.report.written).toEqual([])
    expect((await refreshAgents({ targetPath: root })).report.written).toEqual([])
    expect(await get('.saasfoundry.json')).toBe(before)
    expect(await git('status', '--porcelain')).toBe('')
  })
  it('replaces local declarations without exposing previous private adapter files', async () => {
    await enable(['gemini-cli'])
    const gemini = await get('GEMINI.md')

    const result = await replace(['codex'])

    expect(result.localAgents).toEqual(['codex'])
    expect(result.configuredAgents).toEqual(['claude-code', 'codex'])
    expect((await privateState()).agents).toEqual(['codex'])
    expect((await privateState()).fileHashes['GEMINI.md']).toBeTruthy()
    expect(await get('GEMINI.md')).toBe(gemini)
    expect(await git('status', '--porcelain')).toBe('')
    expect((await refreshAgents({ targetPath: root })).report.written).toEqual([])
    expect(await git('status', '--porcelain')).toBe('')
  })
  it('promotes local Gemini wrapper into reviewable shared files', async () => {
    await enable(['gemini-cli'])
    const result = await enableAgents({ targetPath: root, agents: ['gemini-cli'], scope: 'shared' })
    expect(result.sharedAgents).toContain('gemini-cli')
    expect((await privateState()).fileHashes['GEMINI.md']).toBeUndefined()
    expect(await git('status', '--porcelain')).toContain('GEMINI.md')
    expect(await get('GEMINI.md')).toContain('@AGENTS.md')
  })
  it('preflights a conflicting tracked Gemini wrapper before writing shared discovery files', async () => {
    await put('GEMINI.md', '# Customized team instructions')
    await commit()
    const config = await get('.git/config')
    const result = await enable(['gemini-cli'])
    expect(result.report.conflicts).toContain('GEMINI.md')
    expect(result.localAgents).not.toContain('gemini-cli')
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await get('GEMINI.md')).toBe('# Customized team instructions')
    expect(await get('.git/config')).toBe(config)
  })
  it('rejects corrupt private inventories before generating files', async () => {
    await put('.git/saasfoundry/agents.json', JSON.stringify({ version: 10, agents: ['gpt'], fileHashes: {} }))
    await expect(enable(['codex'])).rejects.toThrow('Invalid private')
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
})
