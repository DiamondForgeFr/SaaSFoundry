import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { AssertionResult } from './assertions'

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.turbo', '.next', 'out'])

export interface NpmAuditTarget {
  cwd: string
  args: string[]
  label: string
  coveredPaths: string[]
}

export type AuditRunner = (cwd: string, args: string[]) => void

function packageJsonAt(directory: string): Record<string, unknown> | undefined {
  const packageJson = join(directory, 'package.json')
  if (!existsSync(packageJson)) return undefined

  try {
    return JSON.parse(readFileSync(packageJson, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function workspacePatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces
  if (Array.isArray(workspaces)) return workspaces.filter((pattern): pattern is string => typeof pattern === 'string')
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const packages = (workspaces as { packages?: unknown }).packages
    if (Array.isArray(packages)) return packages.filter((pattern): pattern is string => typeof pattern === 'string')
  }
  return []
}

function findLockFiles(root: string): string[] {
  const lockFiles: string[] = []
  const visit = (directory: string) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue
      const fullPath = join(directory, entry.name)
      if (entry.isFile() && entry.name === 'package-lock.json') {
        lockFiles.push(fullPath)
      } else if (entry.isDirectory()) {
        visit(fullPath)
      }
    }
  }

  visit(root)
  return lockFiles.sort()
}

function discoverWorkspaceDirectories(lockRoot: string): string[] {
  const packageJson = packageJsonAt(lockRoot)
  const patterns = packageJson ? workspacePatterns(packageJson) : []
  const directories = new Set<string>()

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const normalizedPattern = negated ? pattern.slice(1) : pattern
    const matches = globSync(join(lockRoot, normalizedPattern), { withFileTypes: true }) as Array<{
      isDirectory: () => boolean
      name: string
      parentPath?: string
      path?: string
    }>
    for (const match of matches) {
      if (!match.isDirectory()) continue
      const directory = resolve(match.parentPath ?? match.path ?? lockRoot, match.name)
      if (!existsSync(join(directory, 'package.json'))) continue
      if (negated) directories.delete(directory)
      else directories.add(directory)
    }
  }

  return [...directories].sort()
}

export function discoverNpmAuditTargets(projectDir: string): NpmAuditTarget[] {
  const root = resolve(projectDir)
  return findLockFiles(root).map((lockFile) => {
    const lockRoot = dirname(lockFile)
    const workspaceDirectories = discoverWorkspaceDirectories(lockRoot)
    const coveredPaths = [lockRoot, ...workspaceDirectories]
    const relativePaths = coveredPaths.map((directory) => relative(root, directory) || '.')
    const workspaceArgs = workspaceDirectories.length > 0 ? ['--workspaces', '--include-workspace-root'] : []

    return {
      cwd: lockRoot,
      args: ['audit', '--audit-level=critical', ...workspaceArgs],
      label: relativePaths.join(', '),
      coveredPaths
    }
  })
}

function defaultAuditRunner(cwd: string, args: string[]): void {
  execFileSync('npm', args, { cwd, stdio: 'pipe', timeout: 120_000 })
}

function errorOutput(error: unknown): string {
  const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
  return [failure.stdout, failure.stderr, failure.message]
    .filter(Boolean)
    .map((value) => (typeof value === 'string' ? value : (value?.toString() ?? '')))
    .join('')
}

function isNetworkFailure(output: string): boolean {
  return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network request failed|fetch failed|audit endpoint returned an error|offline mode/i.test(output)
}

export function auditCriticalWorkspaces(projectDir: string, runner: AuditRunner = defaultAuditRunner): AssertionResult[] {
  const targets = discoverNpmAuditTargets(projectDir)
  if (targets.length === 0) {
    return [{ passed: false, message: `FAIL: no package-lock.json found under ${projectDir}` }]
  }

  return targets.map((target) => {
    try {
      runner(target.cwd, target.args)
      return { passed: true, message: `OK: ${target.label} has no critical advisories` }
    } catch (error) {
      const output = errorOutput(error)
      if (isNetworkFailure(output)) {
        throw new Error(`npm audit could not reach the registry for ${target.label}: ${output.slice(-500)}`)
      }
      return {
        passed: false,
        message: `FAIL: ${target.label} has critical advisories\n${output.slice(-1500)}`
      }
    }
  })
}
