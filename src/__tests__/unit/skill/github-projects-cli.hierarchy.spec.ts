import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.resolve(REPO_ROOT, '.claude/skills/sf-tool-github-projects/github-projects-cli.sh')

async function sandbox(subIssues: string, fails = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-gh-hierarchy-'))
  const bin = path.join(dir, 'bin')
  await writeFile(path.join(dir, '.saasfoundry.json'), JSON.stringify({ workflow: { projectUrl: 'https://github.com/orgs/Fake/projects/42' } }))
  await writeFile(path.join(dir, 'placeholder'), '')
  await import('fs/promises').then(({ mkdir }) => mkdir(bin))
  const gh = `#!/bin/bash
if [ "$1" = repo ]; then printf 'Fake/repo'; exit 0; fi
if [ "$1" = api ] && [[ "$*" == *sub_issues* ]]; then
  ${fails ? 'exit 1' : `printf '%s' '${subIssues.replace(/'/g, "'\\''")}'`}
  exit 0
fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  if [[ "$*" == *n=10* ]]; then printf '%s' '{"data":{"repository":{"issue":{"title":"done","state":"OPEN","projectItems":{"nodes":[{"id":"a","project":{"number":42},"fieldValueByName":{"name":"Done"}}]}}}}}'; else printf '%s' '{"data":{"repository":{"issue":{"title":"working","state":"OPEN","projectItems":{"nodes":[{"id":"b","project":{"number":42},"fieldValueByName":{"name":"In progress"}}]}}}}}'; fi
fi
`
  const ghPath = path.join(bin, 'gh')
  writeFileSync(ghPath, gh)
  chmodSync(ghPath, 0o755)
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('github-projects CLI — native child status adapter', () => {
  it('paginates and returns each child that is not Done on the configured board', async () => {
    const s = await sandbox('[[{"number":10},{"number":11}]]')
    try {
      const { stdout } = await execFileP('/bin/bash', [CLI, 'list-incomplete-children', '7'], { cwd: s.dir, env: s.env })
      expect(JSON.parse(stdout)).toEqual([{ number: 11, title: 'working', status: 'In progress' }])
    } finally {
      await s.cleanup()
    }
  })

  it('fails closed when the sub-issues request fails', async () => {
    const s = await sandbox('', true)
    try {
      await expect(execFileP('/bin/bash', [CLI, 'list-incomplete-children', '7'], { cwd: s.dir, env: s.env })).rejects.toMatchObject({ code: 1 })
    } finally {
      await s.cleanup()
    }
  })
})
