import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { statusCommand } from '../../commands/status'
import { writeManifest } from '../../utils'
import type { SaaSFoundryManifest } from '../../types'
import { execFileSync, spawnSync } from 'child_process'
import { resolve } from 'path'

const CLI_ROOT = resolve(__dirname, '../../..')

function captureStdout(): { stop: () => string } {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    return true
  }) as typeof process.stdout.write
  return {
    stop: () => {
      process.stdout.write = originalWrite
      return buf
    }
  }
}

describe('status command (E2E)', () => {
  let tempDir: string
  let originalCwd: string
  let originalExitCode: typeof process.exitCode

  beforeAll(() => {
    execFileSync(process.execPath, [join(CLI_ROOT, 'node_modules/typescript/bin/tsc')], { cwd: CLI_ROOT, stdio: 'pipe' })
  })

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-e2e-status-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    originalExitCode = process.exitCode
    await mkdir(tempDir, { recursive: true })
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    process.exitCode = originalExitCode
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('emits JSON with a failing manifest precondition on a non-project directory', async () => {
    const cap = captureStdout()
    await statusCommand({ json: true })
    const out = cap.stop()
    const parsed = JSON.parse(out)
    expect(parsed.manifest).toBeNull()
    const manifestCheck = parsed.preconditions.find((p: { name: string }) => p.name === 'manifest')
    expect(manifestCheck.status).toBe('fail')
    expect(process.exitCode).toBe(1)
  })

  it('emits Claude-friendly markdown on a valid SaaSFoundryAI project', async () => {
    const manifest: SaaSFoundryManifest = {
      version: '1.0.0-beta',
      generatedAt: new Date().toISOString(),
      structure: 'monorepo',
      projectName: 'demo',
      workflow: { tool: 'github-projects' }
    }
    await writeManifest(tempDir, manifest)

    const cap = captureStdout()
    await statusCommand({ claudeFriendly: true })
    const out = cap.stop()
    expect(out).toContain('# SaaSFoundryAI project status')
    expect(out).toContain('project: demo')
    expect(out).toContain('workflow: github-projects')
    expect(out).toContain('## How to use this output')
  })

  it('does not set exit code to 1 when --claude-friendly is used even with fail preconditions', async () => {
    const cap = captureStdout()
    process.exitCode = 0
    await statusCommand({ claudeFriendly: true })
    cap.stop()
    expect(process.exitCode).toBe(0)
  })

  it('accepts both compiled CLI aliases with identical output and failure semantics', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(CLI_ROOT, 'bin/sf.js'), 'status', '--no-network', ...args], { cwd: tempDir, encoding: 'utf8' })
    const neutral = run('--agent-friendly')
    const legacy = run('--claude-friendly')
    expect(neutral.status).toBe(0)
    expect(neutral.stderr).toBe('')
    expect(neutral.stdout).toBe(legacy.stdout)
    expect(legacy.status).toBe(0)
    expect(neutral.stdout).toContain('[fail]')
    expect(neutral.stdout).toContain('How to use this output')

    const json = run('--json')
    const neutralJson = run('--json', '--agent-friendly')
    const legacyJson = run('--json', '--claude-friendly')
    expect(json.status).toBe(1)
    expect(neutralJson.status).toBe(0)
    expect(legacyJson.status).toBe(0)
    expect(JSON.parse(neutralJson.stdout)).toEqual(JSON.parse(json.stdout))
    expect(neutralJson.stdout).toBe(legacyJson.stdout)
  })
})
