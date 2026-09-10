import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import {
  ADOPTION_COMMON_INSTRUCTIONS,
  AgentInstructionsError,
  CODEX_SOURCE_CLAUDE_BRIDGE,
  COMMON_INSTRUCTIONS,
  SELF_ONBOARDING_INSTRUCTIONS,
  HarnessAgent,
  inspectInstructionSource,
  installAgentInstructions,
  installPlannedAgentInstructions,
  planAgentInstructions
} from '../../../harness/agent-instructions'

const SKILL = `---
name: commit
description: Commit changes
model: haiku
allowed-tools:
  - Bash
context: fork
agent: Explore
---
# Commit
Git state: !\`git status\`
Use Task tool for work. PARALLEL ONLY.
User: $ARGUMENTS
Run .claude/skills/sf-workflow/workflow-cli.sh.
`

describe('shared agent instructions', () => {
  let root: string
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const get = (path: string) => readFile(join(root, path), 'utf8')
  const install = (fileHashes?: Record<string, string>) => installAgentInstructions({ targetPath: root, agents: ['codex', 'kimi'], manifest: { fileHashes } })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-shared-harness-'))
    await put('CLAUDE.md', '# Custom project\nUse develop and the guarded workflow.\n')
    await put('.claude/skills/sf-git-commit/SKILL.md', SKILL)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('adapts shared discovery and capabilities while keeping project and Claude instructions intact', async () => {
    const before = await get('CLAUDE.md')
    const result = await install()
    const shared = await get('.agents/skills/sf-git-commit/SKILL.md')
    expect(shared).toContain('name: sf-git-commit')
    expect(shared).not.toMatch(/^(?:model|agent|context|allowed-tools):/m)
    expect(shared).not.toContain('  - Bash')
    expect(shared).not.toContain('$ARGUMENTS')
    expect(shared).not.toContain('!`')
    expect(shared).not.toContain('PARALLEL ONLY')
    expect(shared).not.toContain('Task tool')
    expect(shared).toContain('run `git status` and read its output')
    expect(shared).toContain('execute the same steps sequentially')
    expect(shared).toContain('not an independent review')
    expect(shared).toContain('project manifest and workflow rules take precedence')
    expect(shared).toContain('.claude/skills/sf-workflow/workflow-cli.sh')
    expect(await get('CLAUDE.md')).toBe(before)
    expect(await get('.claude/skills/sf-git-commit/SKILL.md')).toBe(SKILL)
    expect(await get('AGENTS.md')).toContain('Read `CLAUDE.md`')
    expect(await get('AGENTS.md')).toContain('`nature:bundled-pr` child')
    expect(await get('AGENTS.md')).toContain('An Epic has no PR')
    expect(await get('AGENTS.md')).toContain('every native child has board status Done')
    expect(await get('AGENTS.md')).toContain('## Parallel implementation and Git worktrees')
    expect(await get('AGENTS.md')).toContain('Read-only exploration and review may use parallel agents')
    expect(await get('AGENTS.md')).toMatch(/use\s+`workflow\.workingBranch`; never hardcode a branch name/)
    expect(await get('AGENTS.md')).toContain('one ticket, branch and worktree path')
    expect(await get('AGENTS.md')).toMatch(/user retains\s+control/)
    expect(await get('AGENTS.md')).toMatch(/only when they are merged and no\s+longer in use/)
    expect(result.warnings.some((w) => w.includes("'model'"))).toBe(true)
  })

  it('keeps the worktree orchestration contract provider-neutral in shared and adoption instructions', () => {
    for (const instructions of [COMMON_INSTRUCTIONS, ADOPTION_COMMON_INSTRUCTIONS]) {
      expect(instructions).toContain('## Parallel implementation and Git worktrees')
      expect(instructions).toContain('configured working branch')
      expect(instructions).toContain('overlapping file ownership')
      expect(instructions).toContain('Read-only exploration and review may use parallel agents')
      expect(instructions).not.toMatch(/\bdevelop\b/)
    }
    expect(CODEX_SOURCE_CLAUDE_BRIDGE).toContain('@AGENTS.md')
  })

  it('publishes universal onboarding entrypoints without copying shared skills for Claude-only configuration', async () => {
    const result = await installAgentInstructions({ targetPath: root, agents: ['claude-code'] })
    expect(result.written).toEqual(['AGENTS.md', 'GEMINI.md'])
    expect(await get('AGENTS.md')).toContain(SELF_ONBOARDING_INSTRUCTIONS)
    expect(await get('GEMINI.md')).toContain('@AGENTS.md')
    await expect(get('.agents/skills/sf-git-commit/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit host identity, add/replace/no-change consent, then local/shared scope', () => {
    for (const instructions of [COMMON_INSTRUCTIONS, ADOPTION_COMMON_INSTRUCTIONS]) {
      expect(instructions).toContain('identity explicitly supplied by the current')
      expect(instructions).toContain('Never infer an identity from a model or provider name')
      expect(instructions).toContain('add the current agent')
      expect(instructions).toContain('replace the declaration')
      expect(instructions).toContain('leave the project unchanged')
      expect(instructions.indexOf('add or replace')).toBeLessThan(instructions.indexOf('local to the'))
      expect(instructions).toContain('sf agents replace <agents...>')
      expect(instructions).toContain('never authorizes deleting existing instructions')
    }
  })

  it('identifies missing, Claude, Codex and mixed instruction sources from regular files', async () => {
    expect(await inspectInstructionSource(root)).toEqual({ source: 'claude', claudeInstructions: true, sharedInstructions: false })
    await put('AGENTS.md', '# Codex rules\n')
    expect(await inspectInstructionSource(root)).toEqual({ source: 'mixed', claudeInstructions: true, sharedInstructions: true })
    await rm(join(root, 'CLAUDE.md'))
    expect(await inspectInstructionSource(root)).toEqual({ source: 'codex', claudeInstructions: false, sharedInstructions: true })
    await rm(join(root, 'AGENTS.md'))
    expect(await inspectInstructionSource(root)).toEqual({ source: 'missing', claudeInstructions: false, sharedInstructions: false })
  })

  it('adopts a Codex source additively without changing its instructions or copying agent-private files', async () => {
    const original = Buffer.from('# Codex project rules\n\x00keep exact bytes\n')
    await rm(join(root, 'CLAUDE.md'))
    await writeFile(join(root, 'AGENTS.md'), original)
    await put('.agents/skills/sf-private/SKILL.md', '# Private shared skill')
    await put('.agents/skills/sf-private/credentials.json', 'secret-value')

    const result = await installAgentInstructions({ targetPath: root, agents: ['claude-code', 'gemini-cli'] })

    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(original)
    expect(await get('CLAUDE.md')).toBe(CODEX_SOURCE_CLAUDE_BRIDGE)
    expect(await get('GEMINI.md')).toBe('# SaaSFoundry shared instructions\n\n@AGENTS.md\n')
    expect(result.written).toEqual(['CLAUDE.md', 'GEMINI.md'])
    await expect(get('.claude/skills/sf-private/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(get('.claude/settings.json')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await get('.agents/skills/sf-private/credentials.json')).toBe('secret-value')
  })

  it('does not add the Claude bridge when Claude Code was not requested for a Codex source', async () => {
    await rm(join(root, 'CLAUDE.md'))
    await put('AGENTS.md', '# Authoritative Codex rules\n')
    const result = await installAgentInstructions({ targetPath: root, agents: ['codex', 'gemini-cli'] })
    expect(result.written).toEqual(['GEMINI.md'])
    await expect(get('CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a Codex-source Claude bridge stable across repeated refreshes', async () => {
    await rm(join(root, 'CLAUDE.md'))
    await put('AGENTS.md', '# Authoritative Codex rules\n')
    const first = await installAgentInstructions({ targetPath: root, agents: ['claude-code', 'gemini-cli'] })
    const second = await installAgentInstructions({
      targetPath: root,
      agents: ['claude-code', 'gemini-cli'],
      manifest: { fileHashes: first.fileHashes }
    })
    expect(second.written).toEqual([])
    expect(second.conflicts).toEqual([])
    expect(second.unchanged).toEqual(['CLAUDE.md', 'GEMINI.md'])
    expect(await inspectInstructionSource(root)).toEqual({ source: 'codex', claudeInstructions: true, sharedInstructions: true })
  })

  it('preserves mixed custom roots and reports AGENTS.md as a normal reconciliation conflict', async () => {
    const claude = await get('CLAUDE.md')
    await put('AGENTS.md', '# Independent Codex rules\n')
    const result = await installAgentInstructions({ targetPath: root, agents: ['codex'] })
    expect(result.conflicts).toContain('AGENTS.md')
    expect(result.warnings.join('\n')).toMatch(/reconcile their authority manually/i)
    expect(await get('CLAUDE.md')).toBe(claude)
    expect(await get('AGENTS.md')).toBe('# Independent Codex rules\n')
    expect(await get('AGENTS.md.saasfoundry.new')).toBe(COMMON_INSTRUCTIONS)
  })

  it('does not invent an instruction source when both roots are missing', async () => {
    await rm(join(root, 'CLAUDE.md'))
    const plan = await planAgentInstructions({ targetPath: root, agents: ['codex'] })
    expect(plan.files).toEqual([])
    expect(plan.warnings.join('\n')).toMatch(/CLAUDE\.md and AGENTS\.md are missing/i)
  })

  it('allows a Claude source without installed compatibility skills and warns explicitly', async () => {
    await rm(join(root, '.claude/skills'), { recursive: true })
    const result = await installAgentInstructions({ targetPath: root, agents: ['codex'] })
    expect(result.written).toEqual(['AGENTS.md', 'GEMINI.md'])
    expect(result.warnings).toContain('.claude/skills: no installed compatibility skills found.')
  })

  it('renders adoption as references only and never copies inline credentials from known bundled files', async () => {
    const skill = '# Workflow\nTOKEN=inline-skill-secret\n'
    const script = '#!/bin/sh\nTOKEN=inline-script-secret\n'
    await put('.claude/skills/sf-workflow/SKILL.md', skill)
    await put('.claude/skills/sf-workflow/workflow-cli.sh', script)

    const result = await installAgentInstructions({ targetPath: root, agents: ['codex', 'gemini-cli'], referenceOnly: true })

    expect(result.written).toEqual(['AGENTS.md', 'GEMINI.md'])
    expect(await get('AGENTS.md')).toBe(ADOPTION_COMMON_INSTRUCTIONS)
    expect(await get('AGENTS.md')).toContain('.claude/skills/*/SKILL.md')
    expect(await get('AGENTS.md')).toContain('.claude/skills/sf-workflow/workflow-cli.sh')
    expect(await get('AGENTS.md')).toContain('## Execution capabilities')
    expect(await get('AGENTS.md')).toContain('## Parallel implementation and Git worktrees')
    expect(await get('.claude/skills/sf-workflow/SKILL.md')).toBe(skill)
    expect(await get('.claude/skills/sf-workflow/workflow-cli.sh')).toBe(script)
    await expect(get('.agents/skills/sf-workflow/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(get('.agents/skills/sf-workflow/workflow-cli.sh')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('infers reference-only refresh from the exact adoption bridge and includes custom Claude skills', async () => {
    await put('.claude/skills/project-custom/SKILL.md', '# Custom procedure\n')
    const first = await installAgentInstructions({ targetPath: root, agents: ['codex'], referenceOnly: true })
    const secondPlan = await planAgentInstructions({ targetPath: root, agents: ['codex'], manifest: { fileHashes: first.fileHashes } })
    expect(secondPlan.files.map((file) => file.path)).toEqual(['AGENTS.md', 'GEMINI.md'])
    expect(secondPlan.files[0].content.toString()).toContain('.claude/skills/*/SKILL.md')
    const second = await installPlannedAgentInstructions(root, secondPlan, first.fileHashes)
    expect(second.written).toEqual([])
    expect(second.conflicts).toEqual([])
    expect(second.unchanged).toEqual(['AGENTS.md', 'GEMINI.md'])
    await expect(get('.agents/skills/project-custom/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['generated Claude bridge', 'CLAUDE.md', CODEX_SOURCE_CLAUDE_BRIDGE, /dangling generated bridge/i],
    ['generated shared bridge', 'AGENTS.md', COMMON_INSTRUCTIONS, /dangling generated bridge/i],
    ['generated adoption bridge', 'AGENTS.md', ADOPTION_COMMON_INSTRUCTIONS, /dangling generated bridge/i]
  ])('rejects a dangling %s before planning files', async (_name, path, content, expected) => {
    await rm(join(root, 'CLAUDE.md'))
    await put(path, content)
    await expect(planAgentInstructions({ targetPath: root, agents: ['codex', 'claude-code'] })).rejects.toThrow(expected)
    await expect(get('GEMINI.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([COMMON_INSTRUCTIONS, ADOPTION_COMMON_INSTRUCTIONS])('rejects an exact generated instruction cycle before writing files', async (sharedBridge) => {
    await put('CLAUDE.md', CODEX_SOURCE_CLAUDE_BRIDGE)
    await put('AGENTS.md', sharedBridge)
    await expect(installAgentInstructions({ targetPath: root, agents: ['gemini-cli'] })).rejects.toThrow(/instruction cycle/i)
    await expect(get('GEMINI.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports partial progress and the failing relative path when a deposit fails', async () => {
    await put('.agents', 'not a directory')
    let failure: unknown
    try {
      await install()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AgentInstructionsError)
    expect(failure).toMatchObject({
      message: expect.stringContaining('.agents/skills/sf-git-commit/SKILL.md'),
      report: { written: ['AGENTS.md', 'GEMINI.md'] }
    })
    expect((failure as AgentInstructionsError).cause).toBeDefined()
    expect((failure as Error).message).not.toContain('Custom project')
  })

  it('adds a Gemini import wrapper and keeps repeated installation idempotent', async () => {
    const result = await installAgentInstructions({ targetPath: root, agents: ['gemini-cli'] })
    expect(await get('GEMINI.md')).toBe('# SaaSFoundry shared instructions\n\n@AGENTS.md\n')
    expect(await get('AGENTS.md')).toContain('Read `CLAUDE.md`')
    expect(result.fileHashes['GEMINI.md']).toBeDefined()
    const repeat = await installAgentInstructions({ targetPath: root, agents: ['gemini-cli', 'codex'], manifest: { fileHashes: result.fileHashes } })
    expect(repeat.written).toEqual([])
    expect(repeat.conflicts).toEqual([])
    expect(repeat.unchanged).toContain('GEMINI.md')
  })

  it('preserves a customized Gemini wrapper and proposes a reconciliation sidecar', async () => {
    const first = await installAgentInstructions({ targetPath: root, agents: ['gemini-cli'] })
    await put('GEMINI.md', '# Personal Gemini instructions\n')
    const result = await installAgentInstructions({ targetPath: root, agents: ['gemini-cli'], manifest: { fileHashes: first.fileHashes } })
    expect(result.conflicts).toEqual(['GEMINI.md'])
    expect(result.fileHashes['GEMINI.md']).toBeUndefined()
    expect(await get('GEMINI.md')).toBe('# Personal Gemini instructions\n')
    expect(await get('GEMINI.md.saasfoundry.new')).toContain('@AGENTS.md')
  })

  it('does not let an undeclared custom Gemini entrypoint block Codex setup', async () => {
    await put('GEMINI.md', '# Personal Gemini instructions\n')
    const result = await installAgentInstructions({ targetPath: root, agents: ['codex'] })
    expect(result.conflicts).toEqual([])
    expect(result.written).toContain('AGENTS.md')
    expect(result.written).not.toContain('GEMINI.md')
    expect(await get('GEMINI.md')).toBe('# Personal Gemini instructions\n')
    await expect(get('GEMINI.md.saasfoundry.new')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['qwen-code', 'generic'] as const)('renders universal portable entrypoints for %s', async (agent) => {
    const result = await installAgentInstructions({ targetPath: root, agents: [agent] })
    expect(result.written).toContain('AGENTS.md')
    expect(result.written).toContain('.agents/skills/sf-git-commit/SKILL.md')
    expect(await get('GEMINI.md')).toContain('@AGENTS.md')
    if (agent === 'generic') {
      expect(result.warnings.join('\n')).toMatch(/manual/i)
      expect(result.warnings.join('\n')).toMatch(/not verified|unverified|not checked|not-checked/i)
    }
  })

  it('rejects an unknown agent after a recognized one before writing discovery files', async () => {
    await expect(installAgentInstructions({ targetPath: root, agents: ['codex', 'unknown-agent' as HarnessAgent] })).rejects.toThrow()
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(get('.agents/skills/sf-git-commit/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('supports legacy workflow skills without frontmatter and reports remaining tool examples', async () => {
    await put('.claude/skills/sf-workflow/SKILL.md', '# Workflow\nRun Task(subagent_type="review") after SessionStart.\n')
    const result = await install()
    const shared = await get('.agents/skills/sf-workflow/SKILL.md')
    expect(shared).toMatch(/^---\nname: sf-workflow\ndescription:/)
    expect(shared).toContain('Do not assume Claude Code hooks')
    expect(result.warnings.some((w) => w.includes('legacy model/tool-specific examples remain'))).toBe(true)
  })

  it('preserves executable scripts and credential paths, skips private files and unrelated skills', async () => {
    const script = '#!/bin/sh\ncat "$HOME/.claude/credentials/notion.json"\n'
    await put('.claude/skills/sf-workflow/SKILL.md', '# Workflow')
    await put('.claude/skills/sf-workflow/workflow-cli.sh', script)
    await chmod(join(root, '.claude/skills/sf-workflow/workflow-cli.sh'), 0o755)
    await put('.claude/skills/sf-git-commit/.env', 'TOKEN=private')
    await put('.claude/skills/custom/SKILL.md', SKILL)
    const result = await install()
    expect(await get('.agents/skills/sf-workflow/workflow-cli.sh')).toBe(script)
    expect((await lstat(join(root, '.agents/skills/sf-workflow/workflow-cli.sh'))).mode & 0o111).toBe(0o111)
    await expect(get('.agents/skills/sf-git-commit/.env')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(get('.agents/skills/custom/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.warnings.some((w) => w.includes('.env'))).toBe(true)
  })

  it('is idempotent and refreshes only files matching recorded baselines', async () => {
    const first = await install()
    const second = await install(first.fileHashes)
    expect(second.written).toEqual([])
    expect(second.conflicts).toEqual([])
    await put('.claude/skills/sf-git-commit/SKILL.md', SKILL.replace('# Commit', '# Better commit'))
    const refreshed = await install(first.fileHashes)
    expect(refreshed.written).toEqual(['.agents/skills/sf-git-commit/SKILL.md'])
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toContain('# Better commit')
  })

  it('never copies unlisted private assets or reconciliation files', async () => {
    for (const name of ['credentials.json', 'token.txt', 'id_rsa', 'SKILL.md.saasfoundry.new']) {
      await put(`.claude/skills/sf-git-commit/${name}`, 'private')
    }
    const report = await install()
    for (const name of ['credentials.json', 'token.txt', 'id_rsa', 'SKILL.md.saasfoundry.new']) {
      await expect(get(`.agents/skills/sf-git-commit/${name}`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(report.warnings.some((warning) => warning.includes(name))).toBe(true)
    }
  })

  it('compares raw bytes when detecting changed auxiliary files', async () => {
    await put('.claude/skills/sf-workflow/SKILL.md', '# Workflow')
    const source = join(root, '.claude/skills/sf-workflow/workflow-cli.sh')
    const target = join(root, '.agents/skills/sf-workflow/workflow-cli.sh')
    await writeFile(source, Buffer.from([0xff]))
    const first = await install()
    await writeFile(target, Buffer.from([0xfe]))
    await writeFile(source, Buffer.from([0xfd]))
    const report = await install(first.fileHashes)
    expect(report.conflicts).toContain('.agents/skills/sf-workflow/workflow-cli.sh')
    expect(await readFile(target)).toEqual(Buffer.from([0xfe]))
  })

  it('emits a single valid description and a supported preflight command', async () => {
    await put('.claude/skills/sf-git-commit/SKILL.md', '---\nname: old\ndescription:\nmodel: haiku\n---\n# Commit')
    await install()
    const shared = await get('.agents/skills/sf-git-commit/SKILL.md')
    expect(shared.match(/^description:/gm)).toHaveLength(1)
    expect(await get('AGENTS.md')).toContain('sf status --claude-friendly --no-network')
    expect(await get('AGENTS.md')).not.toContain('--agent-friendly')
  })

  it('keeps multiline discovery descriptions so skill triggers survive adaptation', async () => {
    await put('.claude/skills/sf-git-commit/SKILL.md', '---\nname: old\ndescription:\n  Trigger when committing\n  or pushing changes.\nallowed-tools: Bash\n---\n# Commit')
    await install()
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toContain('description: "Trigger when committing or pushing changes."')
  })

  it('keeps shared Markdown links pointing at the existing common documentation', async () => {
    await put('.claude/skills/sf-workflow/SKILL.md', '# Workflow\nRead [manifest](../../docs/manifest-schema.md) and [phase](statuses/1-backlog.md).')
    await install()
    const shared = await get('.agents/skills/sf-workflow/SKILL.md')
    expect(shared).toContain('[manifest](../../../.claude/docs/manifest-schema.md)')
    expect(shared).toContain('[phase](statuses/1-backlog.md)')
  })

  it('never overwrites existing user instructions, changed tracked files or reconciliation sidecars', async () => {
    const first = await install()
    await put('AGENTS.md', '# User rules')
    await put('.agents/skills/sf-git-commit/SKILL.md', '# Custom skill')
    await put('AGENTS.md.saasfoundry.new', '# Existing user reconciliation')
    const result = await install(first.fileHashes)
    expect(result.conflicts).toEqual(['AGENTS.md', '.agents/skills/sf-git-commit/SKILL.md'])
    expect(Object.keys(result.fileHashes)).toEqual(['GEMINI.md'])
    expect(await get('AGENTS.md')).toBe('# User rules')
    expect(await get('AGENTS.md.saasfoundry.new')).toBe('# Existing user reconciliation')
    expect(await get('.agents/skills/sf-git-commit/SKILL.md')).toBe('# Custom skill')
    expect(await get('.agents/skills/sf-git-commit/SKILL.md.saasfoundry.new')).toContain('name: sf-git-commit')
    const rerun = await install(first.fileHashes)
    expect(rerun.written).toEqual([])
  })

  it('preserves untracked files as user-owned', async () => {
    await put('AGENTS.md', '# Existing Codex rules')
    const result = await install()
    expect(result.conflicts).toContain('AGENTS.md')
    expect(await get('AGENTS.md')).toBe('# Existing Codex rules')
    expect(await get('AGENTS.md.saasfoundry.new')).toContain('Read `CLAUDE.md`')
  })

  it('rejects linked instruction roots before traversing any destination', async () => {
    await put('outside/keep.md', '# Keep this')
    await symlink(join(root, 'outside/keep.md'), join(root, 'AGENTS.md'))
    await symlink(join(root, 'outside'), join(root, '.agents'))
    await expect(install()).rejects.toThrow(/symbolic links are not allowed/i)
    expect(await get('outside/keep.md')).toBe('# Keep this')
    await expect(get('outside/skills/sf-git-commit/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not copy symlink skill sources and leaves sidecar links intact', async () => {
    await put('AGENTS.md', '# Local')
    await put('keep.md', '# Keep')
    await symlink(join(root, 'keep.md'), join(root, 'AGENTS.md.saasfoundry.new'))
    await symlink(join(root, '.claude/skills/sf-git-commit'), join(root, '.claude/skills/sf-linked'))
    const result = await install()
    expect(await get('keep.md')).toBe('# Keep')
    expect(result.warnings.some((w) => w.includes('symbolic link sidecar'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('sf-linked'))).toBe(true)
    await expect(get('.agents/skills/sf-linked/SKILL.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
