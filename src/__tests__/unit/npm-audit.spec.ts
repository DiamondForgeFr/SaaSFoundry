import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { auditCriticalWorkspaces, discoverNpmAuditTargets } = require('../../../tests/docker/npm-audit') as {
  auditCriticalWorkspaces: (projectDir: string, runner?: (cwd: string, args: string[]) => void) => Array<{ passed: boolean; message: string }>
  discoverNpmAuditTargets: (projectDir: string) => Array<{
    cwd: string
    args: string[]
    coveredPaths: string[]
  }>
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

describe('npm audit workspace discovery', () => {
  let project: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'sf-npm-audit-'))
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('discovers every monorepo workspace and audits it through the root lockfile', () => {
    writeJson(join(project, 'package.json'), { name: 'root', workspaces: ['apps/*', 'packages/*'] })
    writeJson(join(project, 'package-lock.json'), { lockfileVersion: 3 })
    for (const workspace of ['apps/api', 'apps/web', 'packages/client']) {
      writeJson(join(project, workspace, 'package.json'), { name: workspace })
    }
    writeJson(join(project, 'node_modules/ignored/package-lock.json'), {})

    const [target] = discoverNpmAuditTargets(project)
    expect(target.args).toEqual(['audit', '--audit-level=critical', '--workspaces', '--include-workspace-root'])
    expect(target.coveredPaths.map((path) => (path === project ? '.' : path.replace(`${project}/`, '')))).toEqual(['.', 'apps/api', 'apps/web', 'packages/client'])

    const calls: Array<{ cwd: string; args: string[] }> = []
    const results = auditCriticalWorkspaces(project, (cwd, args) => calls.push({ cwd, args }))
    expect(results).toEqual([
      {
        passed: true,
        message: 'OK: ., apps/api, apps/web, packages/client has no critical advisories'
      }
    ])
    expect(calls).toEqual([{ cwd: project, args: target.args }])
  })

  it('supports npm workspaces object syntax', () => {
    writeJson(join(project, 'package.json'), { name: 'root', workspaces: { packages: ['modules/*'] } })
    writeJson(join(project, 'package-lock.json'), { lockfileVersion: 3 })
    writeJson(join(project, 'modules/one/package.json'), { name: 'one' })

    const [target] = discoverNpmAuditTargets(project)
    expect(target.coveredPaths).toContain(join(project, 'modules/one'))
    expect(target.args).toContain('--workspaces')
  })

  it('discovers independent multirepo lock roots without assuming directory names', () => {
    for (const repo of ['server-app', 'client-app']) {
      writeJson(join(project, repo, 'package.json'), { name: repo })
      writeJson(join(project, repo, 'package-lock.json'), { lockfileVersion: 3 })
    }

    const targets = discoverNpmAuditTargets(project)
    expect(targets.map((target) => target.cwd)).toEqual([join(project, 'client-app'), join(project, 'server-app')])
    expect(targets.every((target) => !target.args.includes('--workspaces'))).toBe(true)
  })

  it('reports advisory failures with the covered workspace paths', () => {
    writeJson(join(project, 'package.json'), { name: 'root', workspaces: ['packages/*'] })
    writeJson(join(project, 'package-lock.json'), { lockfileVersion: 3 })
    writeJson(join(project, 'packages/vulnerable-fixture/package.json'), { name: 'vulnerable-fixture' })
    const runner = () => {
      const error = new Error('npm audit found 1 critical vulnerability') as Error & { stdout: string }
      error.stdout = 'critical vulnerability in vulnerable-fixture'
      throw error
    }

    const [result] = auditCriticalWorkspaces(project, runner)
    expect(result.passed).toBe(false)
    expect(result.message).toContain('packages/vulnerable-fixture')
  })

  it('throws a distinct error when the registry cannot be reached', () => {
    writeJson(join(project, 'package.json'), { name: 'root' })
    writeJson(join(project, 'package-lock.json'), { lockfileVersion: 3 })

    expect(() =>
      auditCriticalWorkspaces(project, () => {
        throw new Error('npm error code ENOTFOUND registry.npmjs.org')
      })
    ).toThrow('could not reach the registry')
  })
})
