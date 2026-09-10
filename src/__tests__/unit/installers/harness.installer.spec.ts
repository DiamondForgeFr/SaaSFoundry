import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { installHarness, installWorkflowArtifacts } from '../../../installers/harness.installer'
import { HarnessAgent, WorkflowConfig } from '../../../types'
import { fileExists } from '../../../utils'

const WORKFLOW: WorkflowConfig = {
  tool: 'github-projects',
  workingBranch: 'develop',
  prTargetBranch: 'develop',
  statuses: [
    { name: 'Backlog', color: 'GRAY' },
    { name: 'Done', color: 'GREEN' }
  ]
}

describe('harness installer', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sf-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  describe('installWorkflowArtifacts', () => {
    it('is a no-op without a workflow or with tool none', async () => {
      await installWorkflowArtifacts({ targetPath: dir })
      await installWorkflowArtifacts({ targetPath: dir, workflow: { tool: 'none' } })

      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-workflow'))).toBe(false)
    })

    it('deposits the workflow skill and the tool skill', async () => {
      await installWorkflowArtifacts({ targetPath: dir, workflow: WORKFLOW })

      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-workflow', 'SKILL.md'))).toBe(true)
      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-tool-github-projects'))).toBe(true)
    })
  })

  describe('installHarness', () => {
    const params = { projectName: 'notulias', version: '9.9.9', mainBranch: 'main' as const, workflow: WORKFLOW }

    it('deposits the full harness on a bare repository', async () => {
      await installHarness({ targetPath: dir, ...params })

      // CLAUDE.md from the harness template, placeholders resolved
      const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
      expect(claudeMd).toContain('# notulias')
      expect(claudeMd).toContain('CLI v9.9.9')
      expect(claudeMd).not.toContain('{{')
      expect(claudeMd).toContain('## Workflow System')

      // Skills + docs + workflow artefacts
      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-workflow', 'SKILL.md'))).toBe(true)
      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-tool-github-projects'))).toBe(true)
      expect(await fileExists(join(dir, '.claude', 'docs'))).toBe(true)
      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-integration-rules'))).toBe(true)

      // Claude Code hooks
      const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'))
      expect(JSON.stringify(settings.hooks.SessionStart)).toContain('sf status --claude-friendly --no-network')
    })

    it('never overwrites an existing CLAUDE.md — only appends the workflow section', async () => {
      const userContent = '# My project\n\nMy own instructions, hands off.\n'
      await writeFile(join(dir, 'CLAUDE.md'), userContent)

      await installHarness({ targetPath: dir, ...params })

      const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
      expect(claudeMd).toContain('My own instructions, hands off.')
      expect(claudeMd).toContain('## Workflow System')
      expect(claudeMd).not.toContain('{{PROJECT_NAME}}')
    })

    it('merges into an existing .claude/settings.json without clobbering it', async () => {
      await mkdir(join(dir, '.claude'), { recursive: true })
      await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }))

      await installHarness({ targetPath: dir, ...params })

      const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'))
      expect(settings.permissions).toEqual({ allow: ['Bash(make test)'] })
      expect(settings.hooks.SessionStart).toBeDefined()
    })

    it('installs optional skills when requested', async () => {
      await installHarness({ targetPath: dir, ...params, advancedSkills: ['context7'] })

      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-tool-context7'))).toBe(true)
    })

    it('works without a workflow (skills-only harness)', async () => {
      await installHarness({ targetPath: dir, projectName: 'bare', version: '1.0.0' })

      expect(await fileExists(join(dir, '.claude', 'skills', 'sf-workflow'))).toBe(false)
      expect(await fileExists(join(dir, '.claude', 'docs'))).toBe(true)
      const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
      expect(claudeMd).toContain('# bare')
    })

    it('adds shared discovery without removing the Claude workflow', async () => {
      await installHarness({ targetPath: dir, ...params, agents: ['claude-code', 'codex', 'kimi'] })

      const instructions = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      expect(instructions).toContain('CLAUDE.md')
      expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('Coding-agent identity and onboarding')
      for (const root of ['.claude', '.agents']) {
        expect(await fileExists(join(dir, root, 'skills', 'sf-workflow', 'SKILL.md'))).toBe(true)
        expect(await fileExists(join(dir, root, 'skills', 'sf-tool-github-projects', 'github-projects-cli.sh'))).toBe(true)
      }
      const sharedCommit = await readFile(join(dir, '.agents', 'skills', 'sf-git-commit', 'SKILL.md'), 'utf8')
      expect(sharedCommit).toMatch(/name: sf-git-commit/)
      expect(sharedCommit).not.toMatch(/^model:/m)
      const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'))
      expect(settings.hooks.SessionStart).toBeDefined()
    })

    it('installs universal onboarding entrypoints without shared skill copies by default', async () => {
      await installHarness({ targetPath: dir, ...params })
      expect(await fileExists(join(dir, 'AGENTS.md'))).toBe(true)
      expect(await fileExists(join(dir, 'GEMINI.md'))).toBe(true)
      expect(await fileExists(join(dir, '.agents'))).toBe(false)
    })

    it.each(['codex', 'gemini-cli', 'qwen-code', 'generic'] as const)('does not reinstall customized Claude skills when adding %s', async (agent) => {
      await installHarness({ targetPath: dir, ...params })
      const path = join(dir, '.claude', 'skills', 'sf-git-commit', 'SKILL.md')
      const customized = '# Custom commit procedure\nUse the project workflow.\n'
      await writeFile(path, customized)
      const instructions = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
      await installHarness({ targetPath: dir, ...params, agents: [agent] })
      expect(await readFile(path, 'utf8')).toBe(customized)
      expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(instructions)
      expect(await readFile(join(dir, '.agents', 'skills', 'sf-git-commit', 'SKILL.md'), 'utf8')).toContain('Custom commit procedure')
    })

    it('rejects unknown mixed agent selections before depositing the legacy harness', async () => {
      await expect(installHarness({ targetPath: dir, ...params, agents: ['codex', 'unknown-agent' as HarnessAgent] })).rejects.toThrow()
      expect(await fileExists(join(dir, 'CLAUDE.md'))).toBe(false)
      expect(await fileExists(join(dir, '.claude'))).toBe(false)
    })

    it('reports a partial existing harness before changing its files', async () => {
      await mkdir(join(dir, '.claude', 'skills', 'personal'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'personal', 'SKILL.md'), 'personal')
      await expect(installHarness({ targetPath: dir, ...params, agents: ['codex'] })).rejects.toThrow('partial harness')
      expect(await fileExists(join(dir, 'CLAUDE.md'))).toBe(false)
      expect(await fileExists(join(dir, '.claude', 'settings.json'))).toBe(false)
      expect(await readFile(join(dir, '.claude', 'skills', 'personal', 'SKILL.md'), 'utf8')).toBe('personal')
    })
  })
})

describe('computeHarnessFileHashes', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sf-harness-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('hashes only the deposit dirs, keyed by project-root-relative path', async () => {
    await installHarness({ targetPath: dir, projectName: 'acme', version: '1.0.0', workflow: { tool: 'github-projects', statuses: [{ name: 'Backlog' }, { name: 'Done' }] } })
    await writeFile(join(dir, 'src-user-file.ts'), 'user code')

    const { computeHarnessFileHashes } = await import('../../../installers/harness.installer')
    const hashes = await computeHarnessFileHashes(dir)

    const keys = Object.keys(hashes)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k.startsWith('.claude/skills/') || k.startsWith('.claude/docs/'))).toBe(true)
    expect(keys).not.toContain('CLAUDE.md')
    expect(keys).not.toContain('.claude/settings.json')
    expect(keys).not.toContain('src-user-file.ts')
    expect(keys.some((k) => k.startsWith('.claude/skills/sf-workflow/'))).toBe(true)
  })

  it('returns an empty map on a repo without deposits', async () => {
    const { computeHarnessFileHashes } = await import('../../../installers/harness.installer')
    expect(await computeHarnessFileHashes(dir)).toEqual({})
  })

  it('does not adopt shared user files into the legacy refresh baseline', async () => {
    await mkdir(join(dir, '.agents', 'skills', 'sf-example'), { recursive: true })
    await mkdir(join(dir, '.agents', 'skills', 'user-example'), { recursive: true })
    await writeFile(join(dir, '.agents', 'skills', 'sf-example', 'SKILL.md'), 'managed')
    await writeFile(join(dir, '.agents', 'skills', 'user-example', 'SKILL.md'), 'user')
    await writeFile(join(dir, 'AGENTS.md'), 'user-owned entry point')
    await writeFile(join(dir, 'GEMINI.md'), 'user-owned Gemini entry point')
    const { computeHarnessFileHashes } = await import('../../../installers/harness.installer')
    expect(Object.keys(await computeHarnessFileHashes(dir))).toEqual([])
  })
})
