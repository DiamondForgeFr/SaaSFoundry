import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import * as adapter from '../../../harness/agent-instructions'
import { enableAgents, readAgentSupport, refreshAgents, replaceAgents } from '../../../harness/agent-support'

const SKILL = '---\nname: commit\ndescription: Commit changes\n---\n# Commit\nFollow the project workflow.\n'
const MANIFEST = {
  version: '1.0.0-beta',
  projectName: 'managed',
  structure: 'cli',
  workflow: { tool: 'github-projects', workingBranch: 'develop' },
  modules: { harness: { version: 4 }, advancedSkills: ['sf-tool-notion'] },
  fileHashes: { 'unrelated.txt': 'preserve-me' }
}

describe('additive managed agent support (#660)', () => {
  let root: string
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const get = (path: string) => readFile(join(root, path), 'utf8')
  const manifest = async () => JSON.parse(await get('.saasfoundry.json'))
  const enable = (agents: string[]) => enableAgents({ targetPath: root, agents, scope: 'shared' })
  const replace = (agents: string[]) => replaceAgents({ targetPath: root, agents, scope: 'shared' })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-agent-support-'))
    await put('.saasfoundry.json', JSON.stringify(MANIFEST, null, 4) + '\n')
    await put('CLAUDE.md', '# Custom common instructions\n')
    await put('.claude/skills/sf-git-commit/SKILL.md', SKILL)
    await put('.claude/settings.json', '{"hooks":{"custom":["preserve"]}}')
    await put('.claude/skills/sf-git-commit/.env', 'TOKEN=private')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('unions Claude, Codex and Kimi without reinstalling legacy files or copying credentials', async () => {
    await enable(['claude-code'])
    await enable(['codex'])
    const result = await enable(['kimi'])
    expect(result.configuredAgents).toEqual(['claude-code', 'codex', 'kimi'])
    expect((await manifest()).modules.harness).toEqual({ version: 4, agents: result.configuredAgents })
    expect(await get('CLAUDE.md')).toBe('# Custom common instructions\n')
    expect(await get('.claude/skills/sf-git-commit/SKILL.md')).toBe(SKILL)
    expect(await get('.claude/settings.json')).toBe('{"hooks":{"custom":["preserve"]}}')
    await expect(get('.agents/skills/sf-git-commit/.env')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await manifest()).fileHashes['unrelated.txt']).toBe('preserve-me')
    expect((await manifest()).workflow).toEqual(MANIFEST.workflow)
    expect((await manifest()).modules.advancedSkills).toEqual(MANIFEST.modules.advancedSkills)
  })
  it('supports adding Claude to managed Codex configuration without replacing Codex', async () => {
    await put('.saasfoundry.json', JSON.stringify({ ...MANIFEST, modules: { harness: { version: 4, agents: ['codex'] } } }))
    const result = await enable(['claude-code'])
    expect(result.configuredAgents).toEqual(['claude-code', 'codex'])
    expect(await get('.claude/skills/sf-git-commit/SKILL.md')).toBe(SKILL)
  })
  it('adds Codex without reconciling an unrelated custom Gemini entrypoint', async () => {
    await put('GEMINI.md', '# Personal Gemini instructions\n')

    const result = await enable(['codex'])

    expect(result.report.conflicts).toEqual([])
    expect(result.sharedAgents).toEqual(['claude-code', 'codex'])
    expect(await get('GEMINI.md')).toBe('# Personal Gemini instructions\n')
    await expect(get('GEMINI.md.saasfoundry.new')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('replaces only the shared declaration and retains prior generated adapters', async () => {
    await enable(['gemini-cli'])
    const gemini = await get('GEMINI.md')

    const result = await replace(['kimi'])

    expect(result.sharedAgents).toEqual(['kimi'])
    expect(result.configuredAgents).toEqual(['kimi'])
    expect((await manifest()).modules.harness.agents).toEqual(['kimi'])
    expect(await get('GEMINI.md')).toBe(gemini)
  })
  it('does not rewrite manifests, skills or hooks on repeat enable or refresh', async () => {
    await enable(['codex', 'codex', 'kimi'])
    const before = await get('.saasfoundry.json')
    const stamp = (await lstat(join(root, '.saasfoundry.json'))).mtimeMs
    const repeated = await enable(['kimi', 'codex'])
    const refreshed = await refreshAgents({ targetPath: root, scope: 'shared' })
    expect(repeated.report.written).toEqual([])
    expect(refreshed.report.written).toEqual([])
    expect(repeated.manifestChanged).toBe(false)
    expect(refreshed.manifestChanged).toBe(false)
    expect(await get('.saasfoundry.json')).toBe(before)
    expect((await lstat(join(root, '.saasfoundry.json'))).mtimeMs).toBe(stamp)
  })
  it('refreshes generated copies using their successful baselines', async () => {
    await enable(['codex'])
    await put('.claude/skills/sf-git-commit/SKILL.md', SKILL + '\nAdditional source instructions.\n')
    const result = await refreshAgents({ targetPath: root, scope: 'shared' })
    expect(result.report.conflicts).toEqual([])
    expect(result.report.written).toContain('.agents/skills/sf-git-commit/SKILL.md')
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toContain('Additional source instructions.')
  })
  it('preserves conflicts and successful baselines without claiming new activation', async () => {
    await put('AGENTS.md', '# My custom instructions\n')
    const result = await enable(['codex'])
    expect(result.report.conflicts).toContain('AGENTS.md')
    expect(result.configuredAgents).toEqual(['claude-code'])
    expect(await get('AGENTS.md')).toBe('# My custom instructions\n')
    expect((await manifest()).modules.harness.agents).toBeUndefined()
    expect((await manifest()).fileHashes['AGENTS.md']).toBeUndefined()
    expect((await manifest()).fileHashes['.agents/skills/sf-git-commit/SKILL.md']).toBeTruthy()
    const sidecar = await get('AGENTS.md.saasfoundry.new')
    await enable(['codex'])
    expect(await get('AGENTS.md.saasfoundry.new')).toBe(sidecar)
  })
  it('does not bless customized destinations as successful refresh baselines', async () => {
    await enable(['codex'])
    const before = await manifest()
    await put('.agents/skills/sf-git-commit/SKILL.md', '# User content')
    const result = await enable(['kimi'])
    expect(result.configuredAgents).toEqual(['claude-code', 'codex'])
    expect(result.report.conflicts).toContain('.agents/skills/sf-git-commit/SKILL.md')
    expect((await manifest()).fileHashes['.agents/skills/sf-git-commit/SKILL.md']).toBe(before.fileHashes['.agents/skills/sf-git-commit/SKILL.md'])
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toBe('# User content')
  })
  it('reads configured support separately from runtime verification', async () => {
    expect(await readAgentSupport(root)).toEqual({
      configuredAgents: ['claude-code'],
      sharedAgents: ['claude-code'],
      localAgents: [],
      discovered: { claudeInstructions: true, sharedInstructions: false, sharedSkills: false },
      runtime: 'not-checked'
    })
    await enable(['codex'])
    expect((await readAgentSupport(root)).discovered).toEqual({ claudeInstructions: true, sharedInstructions: true, sharedSkills: true })
  })
  it('supports legacy managed manifests without a harness stamp', async () => {
    await put('.saasfoundry.json', JSON.stringify({ version: '1', projectName: 'legacy', structure: 'cli' }))
    expect((await enable(['codex'])).configuredAgents).toEqual(['claude-code', 'codex'])
    expect((await manifest()).modules.harness.version).toBe(1)
    expect(Object.keys((await manifest()).fileHashes).every((key) => ['AGENTS.md', 'GEMINI.md'].includes(key) || key.startsWith('.agents/'))).toBe(true)
  })
  it.each(['project', 'SHARED'])('refuses unsupported scope %s before changing files', async (scope) => {
    const before = await get('.saasfoundry.json')
    await expect(enableAgents({ targetPath: root, agents: ['codex'], scope })).rejects.toThrow('scope must be')
    expect(await get('.saasfoundry.json')).toBe(before)
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(['AGENTS.md', '.agents', '.saasfoundry.agents.lock']))
  })
  it.each([[], ['gpt-5'], ['claude'], ['unknown', 'codex']])('rejects unknown/model agent identifiers %j without partial application', async (...agents) => {
    const before = await get('.saasfoundry.json')
    await expect(enable(agents)).rejects.toThrow('Choose coding agents')
    expect(await get('.saasfoundry.json')).toBe(before)
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
  it.each(['{}', '[]', '{bad', JSON.stringify({ ...MANIFEST, modules: [] }), JSON.stringify({ ...MANIFEST, fileHashes: [] })])('rejects invalid manifests without mutation: %s', async (content) => {
    await put('.saasfoundry.json', content)
    await expect(enable(['codex'])).rejects.toThrow('Invalid')
    expect(await get('.saasfoundry.json')).toBe(content)
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
  it.each(['.saasfoundry.json', 'CLAUDE.md'])('rejects missing required managed harness path %s', async (target) => {
    await rm(join(root, target), { recursive: true })
    await expect(enable(['codex'])).rejects.toThrow('No managed harness')
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
  it.each(['.saasfoundry.json', 'CLAUDE.md', '.claude', '.agents'])('rejects symlink targets and ancestors %s before writing', async (target) => {
    const external = await mkdtemp(join(tmpdir(), 'sf-agent-external-'))
    try {
      await writeFile(join(external, 'file'), '# untouched')
      await rm(join(root, target), { recursive: true, force: true })
      await symlink(target.endsWith('.json') || target.endsWith('.md') ? join(external, 'file') : external, join(root, target))
      await expect(enable(['codex'])).rejects.toThrow('symbolic link')
      expect(await readFile(join(external, 'file'), 'utf8')).toBe('# untouched')
      expect(await readdir(external)).toEqual(['file'])
      expect(await readdir(root)).not.toContain('AGENTS.md')
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
  it('rejects a directory in place of a manifest', async () => {
    await rm(join(root, '.saasfoundry.json'))
    await mkdir(join(root, '.saasfoundry.json'))
    await expect(enable(['codex'])).rejects.toThrow('regular file')
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
  it('does not overwrite a manifest changed while generating artifacts', async () => {
    const actual = adapter.installAgentInstructions
    jest.spyOn(adapter, 'installAgentInstructions').mockImplementationOnce(async (params) => {
      const result = await actual(params)
      await put('.saasfoundry.json', JSON.stringify({ ...MANIFEST, projectName: 'concurrent-edit' }))
      return result
    })
    await expect(enable(['codex'])).rejects.toThrow('Manifest changed during')
    expect((await manifest()).projectName).toBe('concurrent-edit')
    expect((await manifest()).modules.harness.agents).toBeUndefined()
    expect(await readdir(root)).not.toContain('.saasfoundry.agents.lock')
    expect((await enable(['codex'])).report.conflicts).toEqual([])
  })
  it('refuses a second writer while an agent setup lock exists', async () => {
    await put('.saasfoundry.agents.lock', 'another operation')
    const before = await get('.saasfoundry.json')
    await expect(enable(['codex'])).rejects.toThrow('Another agent setup')
    expect(await get('.saasfoundry.json')).toBe(before)
    expect(await get('.saasfoundry.agents.lock')).toBe('another operation')
    expect(await readdir(root)).not.toContain('AGENTS.md')
  })
})
