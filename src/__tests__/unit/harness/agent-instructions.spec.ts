import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { installAgentInstructions } from '../../../harness/agent-instructions'

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
    expect(result.warnings.some((w) => w.includes("'model'"))).toBe(true)
  })

  it('is opt-in and does not generate files for Claude-only configuration', async () => {
    expect((await installAgentInstructions({ targetPath: root, agents: ['claude-code'] })).written).toEqual([])
    await expect(get('AGENTS.md')).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('never overwrites existing user instructions, changed tracked files or reconciliation sidecars', async () => {
    const first = await install()
    await put('AGENTS.md', '# User rules')
    await put('.agents/skills/sf-git-commit/SKILL.md', '# Custom skill')
    await put('AGENTS.md.saasfoundry.new', '# Existing user reconciliation')
    const result = await install(first.fileHashes)
    expect(result.conflicts).toEqual(['AGENTS.md', '.agents/skills/sf-git-commit/SKILL.md'])
    expect(result.fileHashes).toEqual({})
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

  it('does not traverse destination symlinks or overwrite symlink sidecars', async () => {
    await put('outside/keep.md', '# Keep this')
    await symlink(join(root, 'outside/keep.md'), join(root, 'AGENTS.md'))
    await symlink(join(root, 'outside'), join(root, '.agents'))
    const result = await install()
    expect(result.conflicts).toContain('AGENTS.md')
    expect(result.conflicts).toContain('.agents/skills/sf-git-commit/SKILL.md')
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
