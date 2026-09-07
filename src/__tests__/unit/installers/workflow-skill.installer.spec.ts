import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { installWorkflowSkill } from '../../../installers/workflow-skill.installer'
import { WorkflowConfig } from '../../../types'

const TEAM_WORKFLOW: WorkflowConfig = {
  tool: 'github-projects',
  template: 'SaaSFoundry AI Workflow',
  workingBranch: 'develop',
  statuses: [
    { name: 'Backlog', color: 'GRAY' },
    { name: 'Ready', color: 'YELLOW' },
    { name: 'In Progress', color: 'BLUE' },
    { name: 'AI Testing', color: 'PURPLE' },
    { name: 'Human Testing', color: 'ORANGE' },
    { name: 'In Review', color: 'PINK' },
    { name: 'Done', color: 'GREEN' }
  ]
}

const SOLO_WORKFLOW: WorkflowConfig = {
  tool: 'github-projects',
  template: 'SaaSFoundry Solo',
  workingBranch: 'main',
  statuses: [
    { name: 'Backlog', color: 'GRAY' },
    { name: 'In Progress', color: 'BLUE' },
    { name: 'AI Testing', color: 'PURPLE' },
    { name: 'In Review', color: 'PINK' },
    { name: 'Done', color: 'GREEN' }
  ]
}

describe('installWorkflowSkill', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sf-wf-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const statusesDir = () => join(dir, '.claude', 'skills', 'sf-workflow', 'statuses')

  it('team preset ships the 7 status docs and no statuses-solo leftovers', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: TEAM_WORKFLOW })

    const files = await readdir(statusesDir())
    expect(files).toContain('5-human-testing.md')
    expect(files.filter((f) => /^\d-/.test(f))).toHaveLength(7)
    await expect(readdir(join(dir, '.claude', 'skills', 'sf-workflow', 'statuses-solo'))).rejects.toThrow()
  })

  it('solo preset ships exactly the 5 solo docs — no orphan Human Testing/Ready files', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: SOLO_WORKFLOW })

    const files = await readdir(statusesDir())
    expect(files.filter((f) => /^\d-/.test(f)).sort()).toEqual(['1-backlog.md', '2-in-progress.md', '3-ai-testing.md', '4-in-review.md', '5-done.md'])
    expect(files).not.toContain('5-human-testing.md')
    expect(files).not.toContain('2-ready.md')
    // SRS drafting phase docs follow the preset
    expect(files.filter((f) => /-(ai-drafting|human-review|spawning)\.md$/.test(f))).toHaveLength(3)
  })

  it('SKILL.md statuses list matches the configured sequence', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: SOLO_WORKFLOW })

    const skillMd = await readFile(join(dir, '.claude', 'skills', 'sf-workflow', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('statuses/4-in-review.md')
    expect(skillMd).not.toContain('human-testing.md')
    expect(skillMd).not.toContain('{{STATUSES_LIST}}')
  })

  it('re-installing with another preset swaps the docs cleanly (in-place upgrade)', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: SOLO_WORKFLOW })
    await installWorkflowSkill({ targetPath: dir, workflow: TEAM_WORKFLOW })

    const files = await readdir(statusesDir())
    expect(files).toContain('5-human-testing.md')
    expect(files.filter((f) => /^\d-/.test(f))).toHaveLength(7)
  })

  it('CLAUDE.md workflow section injection is idempotent across re-installs', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# proj\n\n## Git Workflow\n\n- main\n\n## Development Commands\n\n- npm test\n')

    await installWorkflowSkill({ targetPath: dir, workflow: SOLO_WORKFLOW })
    await installWorkflowSkill({ targetPath: dir, workflow: TEAM_WORKFLOW })

    const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd.match(/## Workflow System/g)).toHaveLength(1)
    expect(claudeMd).toContain('SaaSFoundry AI Workflow')
    expect(claudeMd).toContain('## Development Commands')
  })
  it('installs the GitHub review listener and preserves a customized existing workflow', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: TEAM_WORKFLOW })
    const listener = join(dir, '.github/workflows/pr-review-sync.yml')
    expect(await readFile(listener, 'utf8')).toContain('pull_request_target:')
    await writeFile(listener, '# customized workflow\n')
    await installWorkflowSkill({ targetPath: dir, workflow: TEAM_WORKFLOW })
    expect(await readFile(listener, 'utf8')).toBe('# customized workflow\n')
  })

  it('does not install a GitHub listener for another workflow backend', async () => {
    await installWorkflowSkill({ targetPath: dir, workflow: { ...TEAM_WORKFLOW, tool: 'jira' } })
    await expect(readFile(join(dir, '.github/workflows/pr-review-sync.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
