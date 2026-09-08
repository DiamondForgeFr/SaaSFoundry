import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'

import { collectAgentDiagnostics, DiagnosticCheck } from '../../../harness/agent-diagnostics'
import { AGENT_REGISTRY_VERSION, getAgentIds } from '../../../harness/agent-registry'

const MANIFEST =
  JSON.stringify(
    {
      version: '1.0.0-beta',
      projectName: 'diagnostic-fixture',
      structure: 'cli',
      workflow: { tool: 'github-projects', workingBranch: 'develop' },
      modules: { harness: { version: 1, agents: ['claude-code', 'codex'] } }
    },
    null,
    2
  ) + '\n'

const nativeIds = ['native.instructions', 'native.skills', 'native.hooks', 'native.authentication', 'native.delegation', 'native.permissions', 'native.tools']

describe('agent capability diagnostics (#650)', () => {
  let root: string
  let originalPath: string | undefined

  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const check = (checks: DiagnosticCheck[], id: string) => {
    const result = checks.find((item) => item.id === id)
    expect(result).toBeDefined()
    return result!
  }
  const agent = <T extends Awaited<ReturnType<typeof collectAgentDiagnostics>>>(report: T, id: string) => {
    const result = report.agents.find((item) => item.id === id)
    expect(result).toBeDefined()
    return result!
  }
  const tree = async (directory = root, relative = ''): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const key = relative ? `${relative}/${name}` : name
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) result[key] = `symlink:${await readlink(path)}`
      else if (stat.isDirectory()) {
        result[key] = `directory:${stat.mode & 0o777}`
        Object.assign(result, await tree(path, key))
      } else result[key] = `file:${stat.mode & 0o777}:${(await readFile(path)).toString('base64')}`
    }
    return result
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-agent-diagnostics-'))
    originalPath = process.env.PATH
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  })

  it('reports every registered profile in registry order by default', async () => {
    const report = await collectAgentDiagnostics(root)
    expect(report.version).toBe(1)
    expect(report.registryVersion).toBe(AGENT_REGISTRY_VERSION)
    expect(report.agents.map(({ id }) => id)).toEqual(getAgentIds())
    expect(check(report.checks, 'project.manifest').status).toBe('unavailable')
  })

  it('preserves requested order, removes duplicates and rejects every unknown ID', async () => {
    const report = await collectAgentDiagnostics(root, { agents: ['generic', 'codex', 'generic'] })
    expect(report.agents.map(({ id }) => id)).toEqual(['generic', 'codex'])
    await expect(collectAgentDiagnostics(root, { agents: ['codex', 'gpt-5'] })).rejects.toThrow('Unknown coding agent')
  })

  it('distinguishes absent optional artifacts from failed inspection', async () => {
    await put('.saasfoundry.json', MANIFEST)
    const report = await collectAgentDiagnostics(root, { agents: ['claude-code', 'codex', 'gemini-cli'] })
    expect(check(report.checks, 'project.manifest').status).toBe('supported')
    for (const diagnostic of report.agents) {
      expect(check(diagnostic.checks, 'artifacts.instructions').status).toBe('unavailable')
      expect(check(diagnostic.checks, 'artifacts.skills').status).toBe('unavailable')
      expect(check(diagnostic.checks, 'artifacts.hooks').status).toBe(diagnostic.id === 'claude-code' || diagnostic.id === 'codex' || diagnostic.id === 'gemini-cli' ? 'unavailable' : 'not-checked')
    }
    expect(report.agents.flatMap(({ checks }) => checks).some(({ status }) => status === 'failed')).toBe(false)
  })

  it('recognizes regular artifacts without claiming native discovery, hooks, auth or delegation', async () => {
    await put('.saasfoundry.json', MANIFEST)
    await put('CLAUDE.md', '# Claude instructions\n')
    await put('AGENTS.md', '# Shared instructions\n')
    await put('GEMINI.md', '# Gemini instructions\n')
    await put('.claude/skills/sf-workflow/SKILL.md', '# Workflow\n')
    await put('.agents/skills/sf-workflow/SKILL.md', '# Workflow\n')
    await put('.claude/settings.json', '{"hooks":{"SessionStart":[]}}\n')

    const report = await collectAgentDiagnostics(root, { agents: ['claude-code', 'codex', 'gemini-cli'] })
    for (const id of ['claude-code', 'codex', 'gemini-cli']) {
      const diagnostic = agent(report, id)
      expect(check(diagnostic.checks, 'artifacts.instructions').status).toBe('supported')
      for (const nativeId of nativeIds) expect(check(diagnostic.checks, nativeId).status).toBe('not-checked')
    }
    expect(check(agent(report, 'claude-code').checks, 'artifacts.skills').status).toBe('supported')
    expect(check(agent(report, 'claude-code').checks, 'artifacts.hooks').status).toBe('supported')
    expect(check(agent(report, 'codex').checks, 'artifacts.skills').status).toBe('supported')
    expect(check(agent(report, 'claude-code').checks, 'registration.shared').status).toBe('supported')
    expect(check(agent(report, 'gemini-cli').checks, 'registration.shared').status).toBe('unavailable')
    expect(check(agent(report, 'codex').checks, 'registration.local').status).toBe('not-checked')
  })

  it('does not expose secrets or configuration contents in reports and initialization guidance', async () => {
    const secret = 'DIAGNOSTIC-CANARY-do-not-print'
    await put('.saasfoundry.json', MANIFEST)
    await put('CLAUDE.md', `# Instructions\nTOKEN=${secret}\n`)
    await put('.claude/settings.json', `{"apiKey":"${secret}","hooks":{"SessionStart":[{"command":"echo ${secret}"}]}}`)
    await put('.claude/skills/private/SKILL.md', `PASSWORD=${secret}\n`)
    const report = await collectAgentDiagnostics(root, { agents: ['claude-code'] })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('PASSWORD')
    for (const id of ['native.authentication', 'native.hooks', 'native.permissions']) expect(check(report.agents[0].checks, id).status).toBe('not-checked')
    const initialization = report.initialization.join('\n').toLowerCase()
    expect(report.initialization.length).toBeGreaterThanOrEqual(6)
    expect(initialization).toContain('sf status --agent-friendly --no-network')
    expect(initialization).toContain('independent review')
    expect(initialization).toContain('keep a required review incomplete')
    expect(initialization).toContain('independent human reviewer')
  })

  it.each([
    ['manifest symlink', '.saasfoundry.json', 'file'],
    ['instruction symlink', 'AGENTS.md', 'file'],
    ['skills symlink', '.agents/skills', 'directory'],
    ['manifest directory', '.saasfoundry.json', 'directory'],
    ['instruction directory', 'AGENTS.md', 'directory'],
    ['skills file', '.agents/skills', 'file']
  ])('reports unsafe or wrong-type paths as failed without following them: %s', async (_label, target, externalKind) => {
    const outside = await mkdtemp(join(tmpdir(), 'sf-agent-diagnostics-outside-'))
    try {
      const destination = join(outside, externalKind === 'directory' ? 'directory' : 'file')
      if (externalKind === 'directory') await mkdir(destination)
      else await writeFile(destination, 'EXTERNAL_SECRET=untouched')
      if (_label.includes('symlink')) {
        await mkdir(dirname(join(root, target)), { recursive: true })
        await symlink(destination, join(root, target))
      } else if (externalKind === 'directory') await mkdir(join(root, target), { recursive: true })
      else await put(target, 'wrong type')

      const report = await collectAgentDiagnostics(root, { agents: ['codex'] })
      const relevant =
        target === '.saasfoundry.json' ? check(report.checks, 'project.manifest') : check(report.agents[0].checks, target === 'AGENTS.md' ? 'artifacts.instructions' : 'artifacts.skills')
      expect(relevant.status).toBe('failed')
      expect(JSON.stringify(report)).not.toContain('EXTERNAL_SECRET')
      if (externalKind === 'file') expect(await readFile(destination, 'utf8')).toBe('EXTERNAL_SECRET=untouched')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.each(['{bad json', '[]', '{"version":"1","projectName":"x","structure":"unknown"}'])('bounds malformed project diagnostics without throwing or echoing content: %s', async (content) => {
    await put('.saasfoundry.json', content)
    const report = await collectAgentDiagnostics(root, { agents: ['generic'] })
    expect(check(report.checks, 'project.manifest').status).toBe('failed')
    expect(JSON.stringify(report)).not.toContain(content)
  })

  it('rejects an oversized manifest without parsing or reflecting its contents', async () => {
    const secret = 'OVERSIZED-DIAGNOSTIC-CANARY'
    await put('.saasfoundry.json', JSON.stringify({ secret, padding: 'x'.repeat(512 * 1024) }))
    const report = await collectAgentDiagnostics(root, { agents: ['generic'] })
    expect(check(report.checks, 'project.manifest').status).toBe('failed')
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('rejects and redacts an arbitrary workflow tool value', async () => {
    const secret = 'WORKFLOW-TOOL-SECRET-CANARY'
    await put('.saasfoundry.json', JSON.stringify({ version: '1', projectName: 'safe-name', structure: 'cli', workflow: { tool: secret }, modules: { harness: { version: 1, agents: ['generic'] } } }))
    const report = await collectAgentDiagnostics(root, { agents: ['generic'] })
    expect(check(report.checks, 'workflow.configuration').status).toBe('failed')
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('continues bounded artifact checks when only workflow configuration is malformed', async () => {
    await put('.saasfoundry.json', JSON.stringify({ version: '1', projectName: 'partial', structure: 'cli', workflow: [], modules: { harness: { version: 1, agents: ['codex'] } } }))
    await put('AGENTS.md', '# Existing instructions\n')
    const report = await collectAgentDiagnostics(root, { agents: ['codex'] })
    expect(check(report.checks, 'project.manifest').status).toBe('supported')
    expect(check(report.checks, 'workflow.configuration').status).toBe('failed')
    expect(check(report.agents[0].checks, 'artifacts.instructions').status).toBe('supported')
  })

  it('refuses to traverse a symbolic-link ancestor of a known artifact', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sf-agent-diagnostics-ancestor-'))
    try {
      await mkdir(join(outside, 'skills/sf-workflow'), { recursive: true })
      await writeFile(join(outside, 'skills/sf-workflow/SKILL.md'), 'OUTSIDE_SECRET=untouched')
      await symlink(outside, join(root, '.agents'))
      const report = await collectAgentDiagnostics(root, { agents: ['codex'] })
      expect(check(report.agents[0].checks, 'artifacts.skills').status).toBe('failed')
      expect(check(report.checks, 'workflow.guard.agents').status).toBe('failed')
      expect(JSON.stringify(report)).not.toContain('OUTSIDE_SECRET')
      expect(await readFile(join(outside, 'skills/sf-workflow/SKILL.md'), 'utf8')).toBe('OUTSIDE_SECRET=untouched')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a project root replaced before the manifest is opened', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sf-agent-diagnostics-swapped-'))
    const savedRoot = `${root}-saved`
    const secret = 'SWAPPED-ROOT-SECRET-CANARY'
    await put('.saasfoundry.json', MANIFEST)
    await writeFile(join(outside, '.saasfoundry.json'), JSON.stringify({ version: '1', projectName: secret, structure: 'cli', workflow: { tool: 'github-projects' } }))
    const promises = jest.requireActual<typeof import('fs/promises')>('fs/promises')
    const actualOpen = promises.open
    jest.spyOn(promises, 'open').mockImplementationOnce((async (path, flags, mode) => {
      await rename(root, savedRoot)
      await symlink(outside, root)
      return actualOpen(path, flags, mode)
    }) as typeof promises.open)

    try {
      const report = await collectAgentDiagnostics(root, { agents: ['generic'] })
      expect(check(report.checks, 'project.manifest').status).toBe('failed')
      expect(JSON.stringify(report)).not.toContain(secret)
    } finally {
      jest.restoreAllMocks()
      await rm(root, { force: true })
      await rename(savedRoot, root)
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('only checks executable metadata when runtime diagnosis is explicitly enabled', async () => {
    const bin = join(root, 'bin')
    const sentinel = join(root, 'executed')
    await mkdir(bin)
    await writeFile(join(bin, 'codex'), `#!/bin/sh\nprintf compromised > '${sentinel}'\n`)
    await chmod(join(bin, 'codex'), 0o755)
    process.env.PATH = bin

    const defaultReport = await collectAgentDiagnostics(root, { agents: ['codex'] })
    expect(check(defaultReport.agents[0].checks, 'runtime.path').status).toBe('not-checked')
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })

    const checkedReport = await collectAgentDiagnostics(root, { agents: ['codex'], checkRuntime: true })
    expect(check(checkedReport.agents[0].checks, 'runtime.path').status).toBe('supported')
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })

    process.env.PATH = ''
    const missingReport = await collectAgentDiagnostics(root, { agents: ['codex'], checkRuntime: true })
    expect(check(missingReport.agents[0].checks, 'runtime.path').status).toBe('unavailable')
  })

  it('does not scan an oversized PATH', async () => {
    process.env.PATH = Array.from({ length: 257 }, (_, index) => join(root, `missing-${index}`)).join(delimiter)
    const oversized = await collectAgentDiagnostics(root, { agents: ['codex'], checkRuntime: true })
    expect(check(oversized.agents[0].checks, 'runtime.path').status).toBe('not-checked')
  })

  it('checks workflow guard files without running them or host prerequisites', async () => {
    const sentinel = join(root, 'guard-executed')
    await put('.claude/skills/sf-workflow/workflow-cli.sh', `#!/bin/sh\nprintf compromised > '${sentinel}'\n`)
    await chmod(join(root, '.claude/skills/sf-workflow/workflow-cli.sh'), 0o755)
    await put('.agents/skills/sf-workflow/workflow-cli.sh', '#!/bin/sh\nexit 0\n')
    const report = await collectAgentDiagnostics(root, { agents: ['generic'] })
    expect(check(report.checks, 'workflow.guard.claude').status).toBe('supported')
    expect(check(report.checks, 'workflow.guard.agents').status).toBe('unavailable')
    expect(check(report.checks, 'workflow.tools').status).toBe('not-checked')
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves project names, bytes, modes and symlinks unchanged', async () => {
    await put('.saasfoundry.json', MANIFEST)
    await put('CLAUDE.md', '# Existing\n')
    await put('.claude/skills/sf-workflow/SKILL.md', '# Skill\n')
    await put('.claude/settings.json', '{"custom":true}\n')
    await symlink('CLAUDE.md', join(root, 'custom-link'))
    await chmod(join(root, 'CLAUDE.md'), 0o640)
    const before = await tree()
    await collectAgentDiagnostics(root)
    await collectAgentDiagnostics(root, { agents: ['claude-code', 'codex'], checkRuntime: true })
    expect(await tree()).toEqual(before)
  })
})
