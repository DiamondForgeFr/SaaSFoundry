import { execFileSync, spawnSync } from 'child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')
const CLI = join(ROOT, 'bin/sf.js')

describe('compiled sf agents doctor command', () => {
  let project: string

  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'pipe' })
  })

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'sf-agents-doctor-'))
  })

  afterEach(async () => rm(project, { recursive: true, force: true }))

  function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync(process.execPath, [CLI, 'agents', 'doctor', ...args], { cwd: project, encoding: 'utf8', env })
  }

  async function put(path: string, content: string, mode?: number): Promise<void> {
    const destination = join(project, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
    if (mode !== undefined) await chmod(destination, mode)
  }

  async function managedProject(): Promise<void> {
    await put(
      '.saasfoundry.json',
      JSON.stringify({
        version: 'test',
        projectName: 'doctor-demo',
        generatedAt: '2026-09-08',
        structure: 'cli',
        workflow: { tool: 'github-projects' },
        modules: { harness: { version: 1, agents: ['claude-code', 'codex', 'kimi', 'gemini-cli', 'qwen-code', 'generic'] } }
      })
    )
    await put('CLAUDE.md', '# Claude project instructions\n')
    await put('AGENTS.md', '# Portable project instructions\n')
    await put('GEMINI.md', '# Gemini project instructions\n')
    await put('.claude/skills/sf-workflow/workflow-cli.sh', '#!/bin/sh\nexit 0\n', 0o755)
    await put('.agents/skills/sf-workflow/workflow-cli.sh', '#!/bin/sh\nexit 0\n', 0o755)
  }

  async function snapshot(root: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {}
    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(directory, entry.name)
        const path = relative(root, absolute)
        const stat = await lstat(absolute)
        if (stat.isSymbolicLink()) entries[path] = `link:${await readlink(absolute)}`
        else if (stat.isDirectory()) {
          entries[path] = `directory:${stat.mode & 0o777}`
          await visit(absolute)
        } else entries[path] = `file:${stat.mode & 0o777}:${(await readFile(absolute)).toString('hex')}`
      }
    }
    await visit(root)
    return entries
  }

  it('diagnoses every registered profile without runtime probes or project writes', async () => {
    await managedProject()
    await put('.claude/settings.json', '{"token":"doctor-secret-canary"}\n')
    await put('.env', 'API_TOKEN=doctor-secret-canary\n')
    const before = await snapshot(project)

    const result = run(['--json'])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.version).toBe(1)
    expect(report.agents.map((agent: { id: string }) => agent.id)).toEqual(['claude-code', 'codex', 'kimi', 'gemini-cli', 'qwen-code', 'generic'])
    expect(report.agents.flatMap((agent: { checks: { id: string; status: string }[] }) => agent.checks.filter((check) => check.id === 'runtime.path').map((check) => check.status))).toEqual([
      'not-checked',
      'not-checked',
      'not-checked',
      'not-checked',
      'not-checked',
      'not-checked'
    ])
    expect(result.stdout).not.toContain('doctor-secret-canary')
    expect(await snapshot(project)).toEqual(before)
  })

  it('checks PATH metadata without executing the discovered runtime', async () => {
    await managedProject()
    const bin = await mkdtemp(join(tmpdir(), 'sf-doctor-bin-'))
    const sentinel = join(bin, 'executed')
    try {
      await writeFile(join(bin, 'codex'), `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`)
      await chmod(join(bin, 'codex'), 0o755)
      const result = run(['codex', '--check-runtime', '--json'], { ...process.env, PATH: bin })
      expect(result.status).toBe(0)
      const report = JSON.parse(result.stdout)
      const runtime = report.agents[0].checks.find((check: { id: string }) => check.id === 'runtime.path')
      expect(runtime.status).toBe('supported')
      expect(runtime.summary).toMatch(/not run|not executed|not invoked/i)
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it('preserves explicit profile order, removes duplicates, and rejects model names as JSON errors', async () => {
    await managedProject()
    const selected = run(['qwen-code', 'codex', 'qwen-code', '--json'])
    expect(selected.status).toBe(0)
    expect(JSON.parse(selected.stdout).agents.map((agent: { id: string }) => agent.id)).toEqual(['qwen-code', 'codex'])

    const unknown = run(['gpt-5', '--json'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toBe('')
    expect(JSON.parse(unknown.stdout).error).toMatch(/unknown coding agent|registered tool profiles/i)
  })

  it('reports a missing manifest as informational initialization work and leaves the partial project untouched', async () => {
    await put('CLAUDE.md', '# Existing instructions\n')
    const before = await snapshot(project)

    const result = run(['claude-code', '--json'])

    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect([...report.checks, ...report.agents.flatMap((agent: { checks: unknown[] }) => agent.checks)].some((check: { status: string }) => check.status === 'failed')).toBe(false)
    expect(report.checks.find((check: { id: string }) => check.id === 'project.manifest').status).toBe('unavailable')
    expect(report.initialization.length).toBeGreaterThan(0)
    expect(await snapshot(project)).toEqual(before)
  })

  it('renders evidence, remediation, and the explicit limits of static diagnostics for humans', async () => {
    await managedProject()
    await rm(join(project, 'AGENTS.md'))
    await mkdir(join(project, 'AGENTS.md'))

    const result = run(['codex'])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Agent diagnostics (read-only)')
    expect(result.stdout).toContain('Evidence:')
    expect(result.stdout).toContain('Remediation:')
    expect(result.stdout).toMatch(/do not assure runtime activation/i)
  })
})
