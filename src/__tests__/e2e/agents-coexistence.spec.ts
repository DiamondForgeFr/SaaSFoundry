import { execFileSync, spawnSync } from 'child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')
const CLI = join(ROOT, 'bin/sf.js')
const INSTALLER = join(ROOT, 'dist/installers/harness.installer.js')
const MIGRATIONS = join(ROOT, 'dist/migrations/manifest/registry.js')
const CHILD_TIMEOUT = 20_000
const MAX_BUFFER = 4 * 1024 * 1024

const AGENTS = ['claude-code', 'codex', 'kimi']
const WORKFLOW = {
  tool: 'github-projects',
  workingBranch: 'develop',
  statuses: [{ name: 'Backlog' }, { name: 'Done' }]
}

function inheritedToolEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!])
  )
}

describe('compiled multi-agent coexistence in generated-layout fixtures (#651)', () => {
  let sandbox: string
  let project: string
  let commandEnv: NodeJS.ProcessEnv

  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: CHILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      env: { ...inheritedToolEnvironment(), CI: 'true' }
    })
  })

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'sf-agent-coexistence-'))
    project = join(sandbox, 'project')
    await mkdir(project)
    const home = join(sandbox, 'home')
    const globalGitConfig = join(sandbox, 'global.gitconfig')
    await mkdir(home)
    await writeFile(globalGitConfig, '')
    commandEnv = {
      ...inheritedToolEnvironment(),
      HOME: home,
      GIT_CONFIG_GLOBAL: globalGitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      SF_SKILL_NO_WARN: '1',
      CI: 'true'
    }
  })

  afterEach(async () => rm(sandbox, { recursive: true, force: true }))

  function runAgents(...args: string[]) {
    return spawnSync(process.execPath, [CLI, 'agents', ...args], { cwd: project, encoding: 'utf8', env: commandEnv, timeout: CHILD_TIMEOUT, maxBuffer: MAX_BUFFER })
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: project, encoding: 'utf8', env: commandEnv, timeout: CHILD_TIMEOUT, maxBuffer: MAX_BUFFER }).trim()
  }

  async function put(path: string, content: string, mode?: number): Promise<void> {
    const destination = join(project, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
    if (mode !== undefined) await chmod(destination, mode)
  }

  async function writeManifest(structure: 'cli' | 'monorepo' | 'multirepo', agents: string[] = AGENTS): Promise<void> {
    await put(
      '.saasfoundry.json',
      JSON.stringify(
        {
          version: 'test',
          generatedAt: '2026-09-09T00:00:00.000Z',
          structure,
          projectName: 'coexistence',
          mainBranch: 'main',
          modules: { harness: { version: 1, agents }, advancedSkills: [] },
          workflow: WORKFLOW
        },
        null,
        2
      ) + '\n'
    )
  }

  async function installCompiledHarness(structure: 'cli' | 'monorepo' | 'multirepo'): Promise<void> {
    await writeManifest(structure)
    if (structure === 'cli') await mkdir(join(project, 'src'))
    if (structure === 'monorepo') {
      await mkdir(join(project, 'apps/api'), { recursive: true })
      await mkdir(join(project, 'apps/web'), { recursive: true })
    }
    if (structure === 'multirepo') {
      await mkdir(join(project, 'apps/coexistence-api'), { recursive: true })
      await mkdir(join(project, 'apps/coexistence-web'), { recursive: true })
    }
    const script = `
      const { installHarness } = require(process.argv[1]);
      installHarness({
        targetPath: process.cwd(), projectName: 'coexistence', version: 'test',
        mainBranch: 'main', workflow: ${JSON.stringify(WORKFLOW)},
        agents: ${JSON.stringify(AGENTS)}
      }).then(report => process.stdout.write(JSON.stringify(report || {})))
        .catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `
    const installed = spawnSync(process.execPath, ['-e', script, INSTALLER], {
      cwd: project,
      encoding: 'utf8',
      env: commandEnv,
      timeout: CHILD_TIMEOUT,
      maxBuffer: MAX_BUFFER
    })
    if (installed.status !== 0) throw new Error(installed.stderr + installed.stdout)
  }

  async function snapshot(root = project): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git') continue
        const absolute = join(directory, entry.name)
        const key = relative(root, absolute).split('\\').join('/')
        const stat = await lstat(absolute)
        if (stat.isSymbolicLink()) result[key] = `link:${await readlink(absolute)}`
        else if (stat.isDirectory()) {
          result[key] = `directory:${stat.mode & 0o777}`
          await visit(absolute)
        } else result[key] = `file:${stat.mode & 0o777}:${(await readFile(absolute)).toString('base64')}`
      }
    }
    await visit(root)
    return result
  }

  it.each(['cli', 'monorepo', 'multirepo'] as const)('installs and idempotently refreshes regular shared artifacts at the %s project root', async (structure) => {
    await installCompiledHarness(structure)

    for (const path of ['CLAUDE.md', 'AGENTS.md', '.claude', '.agents']) {
      expect((await lstat(join(project, path))).isSymbolicLink()).toBe(false)
    }
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain('CLAUDE.md')
    for (const root of ['.claude', '.agents']) {
      expect(await readFile(join(project, root, 'skills/sf-workflow/SKILL.md'), 'utf8')).toContain('# Workflow github-projects')
      expect((await lstat(join(project, root, 'skills/sf-workflow/workflow-cli.sh'))).isFile()).toBe(true)
    }
    for (const app of (await readdir(join(project, structure === 'cli' ? 'src' : 'apps'))).filter(Boolean)) {
      await expect(readFile(join(project, structure === 'cli' ? 'src' : 'apps', app, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const first = runAgents('refresh', '--scope', 'shared', '--json')
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout).report.conflicts).toEqual([])
    const afterFirst = await snapshot()
    const second = runAgents('refresh', '--scope', 'shared', '--json')
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout).report.written).toEqual([])
    expect(await snapshot()).toEqual(afterFirst)
  })

  it('keeps local support private in a monorepo and makes an explicit shared promotion clone-visible', async () => {
    await writeManifest('monorepo', ['claude-code'])
    await mkdir(join(project, 'apps/api'), { recursive: true })
    await mkdir(join(project, 'apps/web'), { recursive: true })
    const installScript = `require(process.argv[1]).installHarness({targetPath:process.cwd(),projectName:'coexistence',version:'test',workflow:${JSON.stringify(WORKFLOW)}}).catch(e=>{console.error(e);process.exitCode=1})`
    execFileSync(process.execPath, ['-e', installScript, INSTALLER], { cwd: project, env: commandEnv, stdio: 'pipe', timeout: CHILD_TIMEOUT, maxBuffer: MAX_BUFFER })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Generated monorepo')
    const branch = git('symbolic-ref', 'HEAD')
    const manifestBefore = await readFile(join(project, '.saasfoundry.json'), 'utf8')

    const local = runAgents('enable', 'codex', '--json')
    expect(local.status).toBe(0)
    expect(JSON.parse(local.stdout).localAgents).toContain('codex')
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(await readFile(join(project, '.saasfoundry.json'), 'utf8')).toBe(manifestBefore)
    expect(git('symbolic-ref', 'HEAD')).toBe(branch)

    const shared = runAgents('enable', 'codex', '--scope', 'shared', '--json')
    expect(shared.status).toBe(0)
    expect(JSON.parse(shared.stdout).sharedAgents).toContain('codex')
    expect(git('status', '--porcelain', '--untracked-files=all')).toMatch(/AGENTS\.md|\.agents\//)
    expect(git('symbolic-ref', 'HEAD')).toBe(branch)
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Share Codex support')

    const clone = join(sandbox, 'clone')
    execFileSync('git', ['clone', '-q', project, clone], { env: commandEnv, stdio: 'pipe', timeout: CHILD_TIMEOUT, maxBuffer: MAX_BUFFER })
    const cloned = spawnSync(process.execPath, [CLI, 'agents', 'list', '--json'], {
      cwd: clone,
      encoding: 'utf8',
      env: commandEnv,
      timeout: CHILD_TIMEOUT,
      maxBuffer: MAX_BUFFER
    })
    expect(cloned.status).toBe(0)
    expect(JSON.parse(cloned.stdout).sharedAgents).toContain('codex')
    expect(JSON.parse(cloned.stdout).localAgents).toEqual([])
  })

  it('runs the actual manifest migration registry before adopting and refreshing an existing Claude project', async () => {
    await put(
      '.saasfoundry.json',
      JSON.stringify({
        version: '0.9.0',
        generatedAt: '2026-01-15T00:00:00.000Z',
        structure: 'monorepo',
        projectName: 'legacy-app',
        modules: { emailService: 'none', s3Setup: 'manual', dbSetup: 'credentials', includeAnalytics: false, advancedSkills: [] },
        workflow: WORKFLOW
      })
    )
    const originalInstructions = '# Existing Claude instructions\n\nKeep this team policy.\n'
    await put('CLAUDE.md', originalInstructions)
    await put('.claude/skills/private/SKILL.md', '# Private team procedure\n')
    const migrate = `
      const fs = require('fs');
      const { runManifestMigrations } = require(process.argv[1]);
      const path = '.saasfoundry.json';
      const result = runManifestMigrations(JSON.parse(fs.readFileSync(path, 'utf8')));
      fs.writeFileSync(path, JSON.stringify(result.manifest, null, 2) + '\\n');
      process.stdout.write(JSON.stringify({from: result.fromVersion, to: result.toVersion, names: result.appliedMigrations.map(m => m.name)}));
    `
    const migrated = execFileSync(process.execPath, ['-e', migrate, MIGRATIONS], {
      cwd: project,
      encoding: 'utf8',
      env: commandEnv,
      timeout: CHILD_TIMEOUT,
      maxBuffer: MAX_BUFFER
    })
    expect(JSON.parse(migrated)).toMatchObject({ from: 0, to: 2, names: ['add-schema-url', 'restructure-email'] })

    const preview = runAgents('adopt', 'claude-code', 'codex', '--scope', 'shared', '--json')
    expect(preview.status).toBe(0)
    const plan = JSON.parse(preview.stdout)
    expect(plan.canApply).toBe(true)
    const applied = runAgents('adopt', 'claude-code', 'codex', '--scope', 'shared', '--apply', '--plan', plan.planId, '--json')
    expect(applied.status).toBe(0)
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe(originalInstructions)
    expect(await readFile(join(project, '.claude/skills/private/SKILL.md'), 'utf8')).toBe('# Private team procedure\n')
    const manifest = JSON.parse(await readFile(join(project, '.saasfoundry.json'), 'utf8'))
    expect(manifest.manifestVersion).toBe(2)
    expect(manifest.modules.email).toEqual({ provider: 'none', version: 1 })
    expect(manifest.modules.emailService).toBeUndefined()

    expect(runAgents('refresh', '--scope', 'shared', '--json').status).toBe(0)
    const stable = await snapshot()
    const repeated = runAgents('refresh', '--scope', 'shared', '--json')
    expect(repeated.status).toBe(0)
    expect(JSON.parse(repeated.stdout).report.written).toEqual([])
    expect(await snapshot()).toEqual(stable)
  })

  it('routes both copied workflow entry points through the same offline adapter and exposes their declared instruction surfaces', async () => {
    await installCompiledHarness('cli')
    const bin = join(sandbox, 'bin')
    const routeLog = join(sandbox, 'routes.log')
    await mkdir(bin)
    await writeFile(
      join(bin, 'jq'),
      `#!/bin/sh
case "$*" in
  *workflow.tool*) printf '%s\\n' github-projects ;;
  *workflow.statuses*) printf '%s\\n' Backlog Done ;;
  *status*) cat >/dev/null; printf '%s\\n' Backlog ;;
  *) cat >/dev/null ;;
esac
`
    )
    await chmod(join(bin, 'jq'), 0o755)
    const adapter = join(project, '.claude/skills/sf-tool-github-projects/github-projects-cli.sh')
    await writeFile(adapter, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROUTE_LOG"\nprintf \'{"status":"Backlog"}\\n\'\n')
    await chmod(adapter, 0o755)
    const env = { ...commandEnv, PATH: `${bin}:${commandEnv.PATH ?? ''}`, ROUTE_LOG: routeLog }

    const outputs = []
    for (const root of ['.claude', '.agents']) {
      const result = spawnSync('bash', [join(project, root, 'skills/sf-workflow/workflow-cli.sh'), 'status', '42'], {
        cwd: project,
        encoding: 'utf8',
        env,
        timeout: CHILD_TIMEOUT,
        maxBuffer: MAX_BUFFER
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Ticket #42 is currently in status: Backlog')
      outputs.push(result.stdout)
    }
    expect(outputs[1]).toBe(outputs[0])
    expect((await readFile(routeLog, 'utf8')).trim().split('\n')).toEqual(['status 42 --json', 'status 42 --json'])

    const catalog = runAgents('catalog', '--json')
    expect(catalog.status).toBe(0)
    const profiles = JSON.parse(catalog.stdout).profiles as { id: string; instructionFile: string }[]
    expect(profiles.find(({ id }) => id === 'claude-code')?.instructionFile).toBe('CLAUDE.md')
    expect(profiles.find(({ id }) => id === 'codex')?.instructionFile).toBe('AGENTS.md')
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toContain('Workflow System')
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain('CLAUDE.md')
  })

  it('rejects an exact-case discovery collision without changing the existing project', async () => {
    await writeManifest('cli', ['claude-code'])
    await put('CLAUDE.md', '# Existing Claude instructions\n')
    await put('agents.md', '# Lowercase user instructions\n')
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Agent tests', '-c', 'user.email=agents@example.test', 'commit', '-qm', 'Case fixture')
    const before = await snapshot()
    const config = await readFile(join(project, '.git/config'), 'utf8')

    const result = runAgents('enable', 'codex', '--json')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/case-collid/i)
    expect(await snapshot()).toEqual(before)
    expect(await readFile(join(project, '.git/config'), 'utf8')).toBe(config)
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(await readFile(join(project, 'agents.md'), 'utf8')).toBe('# Lowercase user instructions\n')
  })
})
