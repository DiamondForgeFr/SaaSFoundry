import { execFile } from 'child_process'
import path from 'path'

const SCRIPT = path.resolve(__dirname, '../../../../scaffolds/skills-templates/tool-saasfoundry/scripts/plan-new.sh')
const BASH = '/bin/bash'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

async function runWithIntent(intent: unknown): Promise<ExecResult> {
  const child = execFile(BASH, [SCRIPT])
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => stdoutChunks.push(c))
  child.stderr?.on('data', (c: string) => stderrChunks.push(c))
  child.stdin?.write(typeof intent === 'string' ? intent : JSON.stringify(intent))
  child.stdin?.end()
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 0)))
  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    code
  }
}

describe('skill/plan-new', () => {
  // `profile` decides whether a stack is scaffolded at all. It was absent from the flag manifest,
  // so plan-new dropped it in silence: an assistant that correctly concluded "this user has an
  // existing repo, use harness" produced a command that scaffolded a full stack over it.
  describe('installation profile', () => {
    it('passes --profile harness through — the "I already have code" case', async () => {
      const { stdout, code } = await runWithIntent({ projectName: 'acme', structure: 'monorepo', profile: 'harness' })
      expect(code).toBe(0)
      expect(stdout).toContain('--profile harness')
    })

    it('rejects an unknown profile value', async () => {
      const { code, stderr } = await runWithIntent({ projectName: 'acme', structure: 'monorepo', profile: 'onlythestack' })
      expect(code).toBe(2)
      expect(stderr).toContain('profile')
    })
  })

  describe('pwa module', () => {
    it('emits --no-pwa when declined', async () => {
      const { stdout, code } = await runWithIntent({ projectName: 'acme', structure: 'monorepo', pwa: false })
      expect(code).toBe(0)
      expect(stdout).toContain('--no-pwa')
    })
  })

  // The deeper bug: silence on unknown input. Any future CLI flag would have been dropped the
  // same way, with nothing to notice.
  describe('unknown intent fields', () => {
    it('fails instead of silently dropping the field', async () => {
      const { code, stderr } = await runWithIntent({ projectName: 'acme', structure: 'monorepo', notAField: 'x' })
      expect(code).toBe(2)
      expect(stderr).toContain('unknown intent field "notAField"')
    })

    it('suggests near misses so a typo is obvious', async () => {
      const { code, stderr } = await runWithIntent({ projectName: 'acme', structure: 'monorepo', profil: 'harness' })
      expect(code).toBe(2)
      expect(stderr).toContain('did you mean')
      expect(stderr).toContain('profile')
    })
  })

  describe('Guided/Express — monorepo backend-only', () => {
    it('builds the minimal command with just projectName + structure', async () => {
      const { stdout, code } = await runWithIntent({ projectName: 'acme', structure: 'monorepo' })
      expect(code).toBe(0)
      expect(stdout.trim()).toBe('sf new --non-interactive --project-name acme --structure monorepo')
    })
  })

  describe('Express — multirepo with modules', () => {
    it('includes db, email, analytics and advanced-skills flags in manifest order', async () => {
      const { stdout, code } = await runWithIntent({
        projectName: 'big-app',
        structure: 'multirepo',
        mainBranch: 'main',
        dbSetup: 'docker',
        emailService: 'mailersend',
        mailersendApiKey: 'ms_live_xxx',
        analytics: true,
        advancedSkills: ['context7', 'notion']
      })
      expect(code).toBe(0)
      expect(stdout.trim()).toBe(
        [
          'sf new',
          '--non-interactive',
          '--project-name big-app',
          '--structure multirepo',
          '--main-branch main',
          '--db-setup docker',
          '--email-service mailersend',
          '--mailersend-api-key ms_live_xxx',
          '--analytics',
          '--advanced-skills context7,notion'
        ].join(' ')
      )
    })
  })

  describe('Explicit coding-agent declaration', () => {
    it('translates registered coding tools to --agents without treating models as profiles', async () => {
      const { stdout, code } = await runWithIntent({
        projectName: 'shared-harness',
        structure: 'monorepo',
        agents: ['claude-code', 'codex']
      })
      expect(code).toBe(0)
      expect(stdout.trim()).toBe('sf new --non-interactive --project-name shared-harness --structure monorepo --agents claude-code,codex')
    })

    it('rejects provider/model names that are not registered coding-tool profiles', async () => {
      const { stderr, code } = await runWithIntent({ projectName: 'bad-agent', structure: 'monorepo', agents: ['gpt'] })
      expect(code).toBe(2)
      expect(stderr).toMatch(/invalid value "gpt" in agents/)
    })
  })

  describe('Guided — partial intent', () => {
    it('exits 2 when a required field is missing', async () => {
      const { code, stderr } = await runWithIntent({ projectName: 'incomplete' })
      expect(code).toBe(2)
      expect(stderr).toMatch(/missing required intent field: structure/)
    })
  })

  describe('Validation — bad enum', () => {
    it('exits 2 with the allowed values listed', async () => {
      const { code, stderr } = await runWithIntent({ projectName: 'x', structure: 'hybrid' })
      expect(code).toBe(2)
      expect(stderr).toMatch(/invalid value "hybrid" for structure; expected one of monorepo, multirepo/)
    })
  })

  describe('Validation — malformed JSON', () => {
    it('exits 2 on non-JSON input', async () => {
      const { code, stderr } = await runWithIntent('not json at all')
      expect(code).toBe(2)
      expect(stderr).toMatch(/invalid JSON on stdin/)
    })

    it('exits 2 on empty stdin', async () => {
      const { code, stderr } = await runWithIntent('')
      expect(code).toBe(2)
      expect(stderr).toMatch(/empty intent on stdin/)
    })

    it('exits 2 on a JSON array at top level', async () => {
      const { code, stderr } = await runWithIntent([])
      expect(code).toBe(2)
      expect(stderr).toMatch(/intent must be a JSON object/)
    })
  })

  describe('Expert — values with spaces and special chars', () => {
    it('shell-quotes risky values', async () => {
      const { stdout, code } = await runWithIntent({
        projectName: 'safe-name',
        structure: 'monorepo',
        projectDescription: 'Acme\'s SaaS with "quotes" & spaces'
      })
      expect(code).toBe(0)
      expect(stdout).toContain('--project-name safe-name')
      expect(stdout).toContain('--structure monorepo')
      expect(stdout).toContain("--project-description 'Acme'\\''s SaaS with \"quotes\" & spaces'")
    })
  })

  describe('Boolean negation', () => {
    it('emits --no-analytics when analytics=false and a negationFlag exists', async () => {
      const { stdout, code } = await runWithIntent({
        projectName: 'x',
        structure: 'monorepo',
        analytics: false
      })
      expect(code).toBe(0)
      expect(stdout).toContain('--no-analytics')
      expect(stdout).not.toContain(' --analytics ')
    })
  })

  describe('CSV validation', () => {
    it('rejects unknown advanced skill values', async () => {
      const { code, stderr } = await runWithIntent({
        projectName: 'x',
        structure: 'monorepo',
        advancedSkills: ['context7', 'badvalue']
      })
      expect(code).toBe(2)
      expect(stderr).toMatch(/invalid value "badvalue" in advancedSkills/)
    })
  })
})
