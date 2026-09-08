import { execFile } from 'child_process'
import { promises as filesystem } from 'fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'

import { applyAgentAdoption, planAgentAdoption } from '../../../harness/agent-adoption'
import * as writer from '../../../harness/agent-file-writer'
import * as instructions from '../../../harness/agent-instructions'
import { refreshAgents } from '../../../harness/agent-support'

const exec = promisify(execFile)
const MANIFEST = { version: '1', projectName: 'adoption-test', structure: 'cli' }

describe('safe existing-project agent adoption (#649)', () => {
  let root: string
  const path = (relative: string) => join(root, relative)
  const put = async (relative: string, content: string | Buffer) => {
    await mkdir(dirname(path(relative)), { recursive: true })
    await writeFile(path(relative), content)
  }
  const get = (relative: string) => readFile(path(relative), 'utf8')
  const missing = (relative: string) => expect(readFile(path(relative))).rejects.toMatchObject({ code: 'ENOENT' })
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim()
  const initGit = async () => git('init', '-q')
  const commit = async () => {
    await git('add', '.')
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture')
  }
  const writeManifest = async (value: unknown = MANIFEST) => put('.saasfoundry.json', JSON.stringify(value, null, 2) + '\n')
  const plan = (agents: string[], scope?: 'local' | 'shared') => planAgentAdoption({ targetPath: root, agents, scope })
  const apply = (agents: string[], planId: string, scope?: 'local' | 'shared') => applyAgentAdoption({ targetPath: root, agents, scope, planId })
  const privateState = async () => JSON.parse(await readFile(join(await git('rev-parse', '--absolute-git-dir'), 'saasfoundry/agents.json'), 'utf8'))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-agent-adoption-'))
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('previews a project without a manifest without creating any files', async () => {
    await put('CLAUDE.md', '# Existing project rules\n')
    const before = await readdir(root)
    const preview = await plan(['codex'], 'shared')
    expect(preview).toMatchObject({ source: 'claude', canApply: false, files: [] })
    expect(preview.planId).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.inventory).toContainEqual({ path: 'CLAUDE.md', kind: 'file' })
    expect(preview.prerequisites.join(' ')).toContain('.saasfoundry.json')
    expect(await readdir(root)).toEqual(before)
  })

  it('reports invalid manifests and rejects unknown agent identifiers without writes', async () => {
    await put('CLAUDE.md', '# Existing rules\n')
    await put('.saasfoundry.json', '{bad')
    const before = await get('.saasfoundry.json')
    const invalid = await plan(['codex'], 'shared')
    expect(invalid.canApply).toBe(false)
    expect(invalid.prerequisites.join(' ')).toMatch(/Invalid JSON|Unexpected token/)
    await expect(apply(['codex'], invalid.planId, 'shared')).rejects.toThrow('conflicts or missing prerequisites')
    await expect(plan(['gpt-5'], 'shared')).rejects.toThrow('Choose coding agents')
    expect(await get('.saasfoundry.json')).toBe(before)
    await missing('AGENTS.md')
  })

  it('adopts a true Claude-only project without requiring legacy skill deposits', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Existing project rules\n')
    await put('.claude/settings.json', '{"custom":true}')
    await put('.claude/settings.local.json', '{"token":"private"}')
    const preview = await plan(['codex'], 'shared')
    expect(preview).toMatchObject({ source: 'claude', canApply: true })
    expect(preview.files).toEqual(expect.arrayContaining([{ path: 'AGENTS.md', action: 'create' }]))
    expect(preview.inventory).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining('settings.local.json/token') }))
    const result = await apply(['codex'], preview.planId, 'shared')
    expect(result.sharedAgents).toEqual(['claude-code', 'codex'])
    expect(await get('CLAUDE.md')).toBe('# Existing project rules\n')
    expect(await get('.claude/settings.json')).toBe('{"custom":true}')
    expect(await get('.claude/settings.local.json')).toBe('{"token":"private"}')
    expect(await get('AGENTS.md')).toContain('CLAUDE.md')
  })

  it('references Claude skills without copying their files or inline credentials', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Existing project rules\n')
    await put('.claude/skills/sf-git-commit/SKILL.md', '---\nname: sf-git-commit\ndescription: Commit code\n---\nAPI_TOKEN=inline-secret\n')
    await put('.claude/skills/sf-git-commit/run.sh', 'export API_KEY=script-secret\n')
    const preview = await plan(['codex'], 'shared')
    expect(preview.canApply).toBe(true)
    expect(preview.files.some((file) => file.path.startsWith('.agents/skills/'))).toBe(false)
    expect(JSON.stringify(preview)).not.toMatch(/inline-secret|script-secret/)
    await apply(['codex'], preview.planId, 'shared')
    const bridge = await get('AGENTS.md')
    expect(bridge).toContain('.claude/skills')
    expect(bridge).not.toMatch(/inline-secret|script-secret/)
    await missing('.agents/skills/sf-git-commit/SKILL.md')
    await missing('.agents/skills/sf-git-commit/run.sh')
    expect(await get('.claude/skills/sf-git-commit/SKILL.md')).toContain('inline-secret')
    expect(await get('.claude/skills/sf-git-commit/run.sh')).toContain('script-secret')
  })

  it.each(['shared', 'local'] as const)('adds Claude to a true Codex-only source in %s scope', async (scope) => {
    if (scope === 'local') await initGit()
    await writeManifest()
    const source = '# Authoritative Codex rules\n'
    await put('AGENTS.md', source)
    await put('.codex/config.toml', 'model = "custom"\n')
    await put('.agents/skills/private/SKILL.md', 'SECRET=keep')
    if (scope === 'local') await commit()
    const preview = await plan(['claude-code'], scope)
    expect(preview).toMatchObject({ source: 'codex', canApply: true })
    expect(preview.files).toContainEqual({ path: 'CLAUDE.md', action: 'create' })
    const result = await apply(['claude-code'], preview.planId, scope)
    expect(result.configuredAgents).toEqual(['claude-code', 'codex'])
    expect(await get('AGENTS.md')).toBe(source)
    expect(await get('CLAUDE.md')).toContain('@AGENTS.md')
    expect(await get('.codex/config.toml')).toBe('model = "custom"\n')
    expect(await get('.agents/skills/private/SKILL.md')).toBe('SECRET=keep')
  })

  it('blocks a mixed custom instruction source before writing any candidate', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Claude custom\n')
    await put('AGENTS.md', '# Codex custom\n')
    const before = await Promise.all(['.saasfoundry.json', 'CLAUDE.md', 'AGENTS.md'].map(get))
    const preview = await plan(['gemini-cli'], 'shared')
    expect(preview).toMatchObject({ source: 'mixed', canApply: false })
    expect(preview.conflicts).toContain('AGENTS.md')
    await expect(apply(['gemini-cli'], preview.planId, 'shared')).rejects.toThrow('conflicts or missing prerequisites')
    expect(await Promise.all(['.saasfoundry.json', 'CLAUDE.md', 'AGENTS.md'].map(get))).toEqual(before)
    await missing('GEMINI.md')
  })

  it.each([
    ['source', async () => put('CLAUDE.md', '# Changed source\n')],
    ['target', async () => put('AGENTS.md', '# Changed target\n')],
    [
      'index',
      async () => {
        await put('unrelated.txt', 'staged\n')
        await git('add', 'unrelated.txt')
      }
    ]
  ] as const)('rejects a stale plan after a %s change without applying more setup', async (_case, mutate) => {
    await initGit()
    await writeManifest()
    await put('CLAUDE.md', '# Existing rules\n')
    await commit()
    const preview = await plan(['codex'])
    await mutate()
    const snapshot = await readdir(root)
    await expect(apply(['codex'], preview.planId)).rejects.toThrow('plan is stale')
    expect(await readdir(root)).toEqual(snapshot)
    await missing('.git/saasfoundry/agents.json')
  })

  it('is repeatable through a fresh plan without changing generated mtimes', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Existing rules\n')
    const first = await plan(['codex'], 'shared')
    await apply(['codex'], first.planId, 'shared')
    const manifestStamp = (await lstat(path('.saasfoundry.json'))).mtimeMs
    const agentsStamp = (await lstat(path('AGENTS.md'))).mtimeMs
    const second = await plan(['codex'], 'shared')
    expect(second.files).toContainEqual({ path: 'AGENTS.md', action: 'reuse' })
    const result = await apply(['codex'], second.planId, 'shared')
    expect(result.report.written).toEqual([])
    expect(result.manifestChanged).toBe(false)
    expect((await lstat(path('.saasfoundry.json'))).mtimeMs).toBe(manifestStamp)
    expect((await lstat(path('AGENTS.md'))).mtimeMs).toBe(agentsStamp)
  })

  it('refreshes adapters while preserving the authoritative Codex source bytes', async () => {
    await writeManifest()
    const source = '# Codex owns these rules\n'
    await put('AGENTS.md', source)
    const preview = await plan(['gemini-cli'], 'shared')
    await apply(['gemini-cli'], preview.planId, 'shared')
    const refreshed = await refreshAgents({ targetPath: root, scope: 'shared' })
    expect(refreshed.report.conflicts).toEqual([])
    expect(await get('AGENTS.md')).toBe(source)
    expect(await get('GEMINI.md')).toContain('@AGENTS.md')
    await missing('CLAUDE.md')
  })

  it('keeps shared refresh reference-only after the generated adoption bridge is customized', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Existing project rules\n')
    await put('.claude/skills/sf-git-commit/SKILL.md', '---\nname: sf-git-commit\ndescription: Commit code\n---\nAPI_TOKEN=inline-secret\n')
    await put('.claude/skills/sf-git-commit/run.sh', 'export API_KEY=script-secret\n')
    const approved = await plan(['codex'], 'shared')
    await apply(['codex'], approved.planId, 'shared')
    const customized = '# Team-customized agent bridge\n'
    await put('AGENTS.md', customized)

    const refreshed = await refreshAgents({ targetPath: root, scope: 'shared' })

    expect(refreshed.report.conflicts).toContain('AGENTS.md')
    expect(JSON.stringify(refreshed.report)).not.toMatch(/inline-secret|script-secret/)
    expect(await get('AGENTS.md')).toBe(customized)
    await missing('.agents/skills/sf-git-commit/SKILL.md')
    await missing('.agents/skills/sf-git-commit/run.sh')
    expect(await get('.claude/skills/sf-git-commit/SKILL.md')).toContain('inline-secret')
    expect(await get('.claude/skills/sf-git-commit/run.sh')).toContain('script-secret')
  })

  it('borrows identical tracked candidates without claiming ownership', async () => {
    await initGit()
    await writeManifest()
    await put('CLAUDE.md', '# Existing rules\n')
    const rendered = await instructions.planAgentInstructions({ targetPath: root, agents: ['claude-code', 'codex'], referenceOnly: true })
    for (const file of rendered.files) await put(file.path, file.content)
    await commit()
    const preview = await plan(['codex'])
    expect(preview.canApply).toBe(true)
    expect(preview.files.every((file) => file.action === 'reuse')).toBe(true)
    await apply(['codex'], preview.planId)
    expect((await privateState()).fileHashes).toEqual({})
    expect(await git('status', '--porcelain')).toBe('')
    expect(await git('config', '--get', 'extensions.worktreeConfig').catch(() => '')).toBe('')
  })

  it('journals a private Claude bridge and accepts its exact bytes on retry', async () => {
    await initGit()
    await writeManifest()
    await put('AGENTS.md', '# Codex source\n')
    await commit()
    const approved = await plan(['claude-code'])
    const actualRename = filesystem.rename
    let inventorySaves = 0
    jest.spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('/saasfoundry/agents.json') && ++inventorySaves === 2) throw new Error('Injected private inventory failure')
      return actualRename(source, destination)
    })
    let failure: unknown
    try {
      await apply(['claude-code'], approved.planId)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining('local adoption stopped before completion'),
      report: expect.objectContaining({ written: expect.arrayContaining(['CLAUDE.md']) }),
      cause: expect.objectContaining({ message: 'Injected private inventory failure' })
    })
    expect((await privateState()).pendingFileHashes['CLAUDE.md']).toMatch(/^[a-f0-9]{64}$/)
    const bridge = await get('CLAUDE.md')
    jest.restoreAllMocks()
    const retry = await plan(['claude-code'])
    await expect(apply(['claude-code'], retry.planId)).resolves.toMatchObject({ localAgents: ['claude-code'] })
    expect(await get('CLAUDE.md')).toBe(bridge)
    expect((await privateState()).pendingFileHashes).toBeUndefined()
  })

  it('writes the candidate bytes captured by locked verification', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Existing rules\n')
    const approved = await plan(['codex'], 'shared')
    const render = instructions.planAgentInstructions
    let renders = 0
    jest.spyOn(instructions, 'planAgentInstructions').mockImplementation(async (params) => {
      const candidate = await render(params)
      renders += 1
      if (renders <= 2) return candidate
      return {
        ...candidate,
        files: candidate.files.map((file) => (file.path === 'AGENTS.md' ? { ...file, content: Buffer.from('# Unreviewed rerender\n') } : file))
      }
    })
    await expect(apply(['codex'], approved.planId, 'shared')).resolves.toMatchObject({ sharedAgents: ['claude-code', 'codex'] })
    expect(await get('AGENTS.md')).toContain('CLAUDE.md')
    expect(await get('AGENTS.md')).not.toContain('Unreviewed rerender')
  })

  it('returns completed writes on partial I/O failure and protects a customized retry target', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Claude source\n')
    const approved = await plan(['gemini-cli'], 'shared')
    const actualWrite = writer.safeWriteAgentFile
    jest.spyOn(writer, 'safeWriteAgentFile').mockImplementation(async (rootPath, relativePath, content, mode, expected) => {
      if (relativePath === 'GEMINI.md') throw new Error('Injected Gemini write failure')
      return actualWrite(rootPath, relativePath, content, mode, expected)
    })
    const actualUnlink = filesystem.unlink
    jest.spyOn(filesystem, 'unlink').mockImplementation(async (target) => {
      if (String(target).endsWith('/.saasfoundry.agents.lock')) throw new Error('Injected lock cleanup failure')
      return actualUnlink(target)
    })
    let failure: unknown
    try {
      await apply(['gemini-cli'], approved.planId, 'shared')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      report: expect.objectContaining({ written: expect.arrayContaining(['AGENTS.md']) }),
      cause: expect.objectContaining({ message: 'Injected Gemini write failure' })
    })
    await put('AGENTS.md', '# User changed partial output\n')
    jest.restoreAllMocks()
    await rm(path('.saasfoundry.agents.lock'))
    const retry = await plan(['gemini-cli'], 'shared')
    expect(retry.canApply).toBe(false)
    await expect(apply(['gemini-cli'], retry.planId, 'shared')).rejects.toThrow('conflicts or missing prerequisites')
    expect(await get('AGENTS.md')).toBe('# User changed partial output\n')
  })

  it('reports lock cleanup failure after successful writes with recovery context', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Claude source\n')
    const approved = await plan(['codex'], 'shared')
    const actualUnlink = filesystem.unlink
    jest.spyOn(filesystem, 'unlink').mockImplementation(async (target) => {
      if (String(target).endsWith('/.saasfoundry.agents.lock')) throw new Error('Injected lock cleanup failure')
      return actualUnlink(target)
    })
    let failure: unknown
    try {
      await apply(['codex'], approved.planId, 'shared')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining('lock cleanup failed'),
      report: expect.objectContaining({ written: expect.arrayContaining(['AGENTS.md']) }),
      recovery: expect.stringContaining('Files or inventory may already be saved'),
      cause: expect.objectContaining({ message: 'Injected lock cleanup failure' })
    })
    expect(JSON.parse(await get('.saasfoundry.json')).modules.harness.agents).toEqual(['claude-code', 'codex'])
    expect(await get('AGENTS.md')).toContain('CLAUDE.md')
  })

  it('recovers generated bytes after a shared manifest save failure', async () => {
    await writeManifest()
    await put('CLAUDE.md', '# Claude source\n')
    const approved = await plan(['codex'], 'shared')
    const actualRename = filesystem.rename
    jest.spyOn(filesystem, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('/.saasfoundry.json')) throw new Error('Injected manifest save failure')
      return actualRename(source, destination)
    })
    let failure: unknown
    try {
      await apply(['codex'], approved.planId, 'shared')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: expect.stringContaining('shared adoption stopped before completion'),
      report: expect.objectContaining({ written: expect.arrayContaining(['AGENTS.md']) }),
      cause: expect.objectContaining({ message: 'Injected manifest save failure' })
    })
    const generated = await get('AGENTS.md')
    jest.restoreAllMocks()
    const retry = await plan(['codex'], 'shared')
    expect(retry.files).toContainEqual({ path: 'AGENTS.md', action: 'reuse' })
    await expect(apply(['codex'], retry.planId, 'shared')).resolves.toMatchObject({ manifestChanged: true })
    expect(await get('AGENTS.md')).toBe(generated)
  })

  it.each(['source', 'destination'] as const)('refuses a symbolic-link %s without touching its target', async (kind) => {
    const outside = await mkdtemp(join(tmpdir(), 'sf-agent-adoption-outside-'))
    const external = join(outside, 'keep')
    await writeFile(external, '# Outside bytes\n')
    try {
      await writeManifest()
      if (kind === 'source') {
        await symlink(external, path('CLAUDE.md'))
      } else {
        await put('CLAUDE.md', '# Claude source\n')
        await symlink(external, path('AGENTS.md'))
      }
      const preview = await plan(['codex'], 'shared')
      expect(preview.canApply).toBe(false)
      expect(preview.prerequisites.join(' ')).toMatch(/symbolic|link/i)
      await expect(apply(['codex'], preview.planId, 'shared')).rejects.toThrow('conflicts or missing prerequisites')
      expect(await readFile(external, 'utf8')).toBe('# Outside bytes\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
