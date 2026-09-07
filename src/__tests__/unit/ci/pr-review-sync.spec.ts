import { readFileSync } from 'fs'
import { resolve } from 'path'
import { load } from 'js-yaml'

const ROOT = resolve(__dirname, '../../../..')

describe('PR review board synchronization workflow', () => {
  const source = readFileSync(resolve(ROOT, 'scaffolds/skills-templates/workflow/github/pr-review-sync.yml'), 'utf8')
  const workflow = load(source) as {
    on: Record<string, { types: string[] }>
    permissions: Record<string, string>
    jobs: { 'sync-review': { if: string; steps: { uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }[] } }
  }
  it('ships the same listener in dogfood and generated projects', () => {
    expect(readFileSync(resolve(ROOT, '.github/workflows/pr-review-sync.yml'), 'utf8')).toBe(source)
    expect(workflow.on).toEqual({ pull_request_target: { types: ['ready_for_review'] } })
  })
  it('only checks out trusted default-branch code and never persists an elevated credential', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const job = workflow.jobs['sync-review']
    expect(job.if).toBe('github.event.pull_request.head.repo.full_name == github.repository')
    const checkout = job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout).toHaveLength(1)
    expect(checkout[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false })
    expect(checkout[0].env).toBeUndefined()
  })
  it('passes event data as arguments, requires the dedicated token and delegates to the guarded CLI', () => {
    const steps = workflow.jobs['sync-review'].steps.filter((step) => step.run)
    expect(steps).toHaveLength(1)
    expect(steps[0].env).toEqual({ GH_TOKEN: '${{ secrets.SF_PROJECTS_TOKEN }}', PR_NUMBER: '${{ github.event.pull_request.number }}' })
    expect(steps[0].run).not.toContain('${{')
    expect(steps[0].run).toContain('[[ -z "$GH_TOKEN" ]]')
    expect(steps[0].run).toContain('workflow-cli.sh sync-pr-review "$PR_NUMBER"')
    expect(steps[0].run).not.toMatch(/npm |eval |gh api/)
  })
})
