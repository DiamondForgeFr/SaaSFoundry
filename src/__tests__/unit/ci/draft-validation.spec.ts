import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { runInNewContext } from 'vm'
import { load } from 'js-yaml'

const ROOT = resolve(__dirname, '../../../..')
const FILES = [
  '.github/workflows/test.yml',
  'scaffolds/blueprints/api/.github/workflows/test.yml',
  'scaffolds/blueprints/web/.github/workflows/test.yml',
  'scaffolds/overlays/monorepo/root/.github/workflows/test.yml'
]
interface Workflow {
  on: { pull_request: { types: string[]; branches: string[] }; push?: { branches: string[] } }
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, { if: string; needs?: string | string[] }>
}

function permits(expression: string, event: string, draft: boolean, base = 'develop'): boolean {
  return Boolean(runInNewContext(expression, { github: { event_name: event, base_ref: base, event: { pull_request: { draft } } } }))
}

describe.each(FILES)('%s draft validation policy', (file) => {
  const workflow = load(readFileSync(join(ROOT, file), 'utf8').replaceAll('{{CI_PR_BRANCHES}}', 'develop, master')) as Workflow
  it('handles draft creation, feedback pushes, reopening, promotion and returning to draft', () => {
    expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']))
    expect(workflow.on.pull_request.branches).toEqual(expect.arrayContaining(['develop', 'master']))
    expect(workflow.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}', 'cancel-in-progress': true })
  })
  it('skips every job on a draft PR, including dependency installation and Docker matrix resolution', () => {
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0)
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBeDefined()
      expect(permits(job.if, 'pull_request', true)).toBe(false)
    }
  })
  it('runs validation for ready PRs while preserving Docker target branch selection', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const base of ['develop', 'master']) {
        const expected = name === 'docker-build-tests-full' ? base === 'master' : name === 'docker-build-tests-quick' ? base === 'develop' : true
        expect(permits(job.if, 'pull_request', false, base)).toBe(expected)
      }
    }
  })
  if (file === '.github/workflows/test.yml') {
    it('preserves protected branch and RC push validation without adding Docker push jobs', () => {
      expect(workflow.on.push?.branches).toEqual(['master', 'develop', 'rc-*'])
      for (const [name, job] of Object.entries(workflow.jobs)) {
        expect(permits(job.if, 'push', false)).toBe(!name.startsWith('docker-'))
      }
    })
  }
})

describe('pre-push validation policy', () => {
  let dir: string
  let bin: string
  let calls: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sf-push-policy-'))
    bin = join(dir, 'bin')
    calls = join(dir, 'npm-calls')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), '#!/bin/sh\ncase "$1" in symbolic-ref) echo "$SF_TEST_BRANCH";; log) exit 0;; esac\n')
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SF_TEST_CALLS"\nexit "${SF_TEST_NPM_EXIT:-0}"\n')
    chmodSync(join(bin, 'git'), 0o755)
    chmodSync(join(bin, 'npm'), 0o755)
    writeFileSync(calls, '')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function env(branch: string, exit = '0'): NodeJS.ProcessEnv {
    return { ...process.env, PATH: `${bin}:${process.env.PATH}`, SF_TEST_BRANCH: branch, SF_TEST_CALLS: calls, SF_TEST_NPM_EXIT: exit }
  }
  it('allows feedback pushes without invoking Docker and points to the mandatory AI-testing validation', () => {
    const out = execFileSync('bash', [join(ROOT, '.husky/pre-push'), 'origin', 'unused'], { cwd: dir, env: env('feature/654-draft'), encoding: 'utf8' })
    expect(readFileSync(calls, 'utf8')).toBe('')
    expect(out).toContain('Before Human testing, run npm run test:pre-push during AI testing')
  })
  it('retains RC version management', () => {
    execFileSync('bash', [join(ROOT, '.husky/pre-push')], { cwd: dir, env: env('rc-release'), stdio: 'pipe' })
    expect(readFileSync(calls, 'utf8').trim()).toBe('run version:manage')
  })
  it('still rejects an RC push if version management fails', () => {
    const result = spawnSync('bash', [join(ROOT, '.husky/pre-push')], { cwd: dir, env: env('rc-release', '1'), encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Version management failed')
  })
})
