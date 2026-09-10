import { mkdir, readFile, writeFile } from 'fs/promises'

import { installAgentInstructions } from '../harness/agent-instructions'
import type { HarnessAgent } from '../harness/agent-registry'
import type { SaaSFoundryManifest } from '../types'

/**
 * Multirepo apps are independent Git checkouts. Agent lifecycle commands run
 * from those checkout roots, so each app needs a regular manifest projection
 * even though the project root remains the canonical scaffold manifest.
 */
export async function writeMultirepoAgentManifests(manifest: SaaSFoundryManifest, projectName: string): Promise<void> {
  if (manifest.structure !== 'multirepo') return

  for (const app of [`apps/${projectName}-api`, `apps/${projectName}-web`]) {
    await mkdir(app, { recursive: true })
    await writeFile(`${app}/.saasfoundry.json`, JSON.stringify({ ...manifest, fileHashes: {} }, null, 2))
  }
}

export async function installSelectedAgentInstructions(manifest: SaaSFoundryManifest, projectName: string, agents: HarnessAgent[] | undefined): Promise<void> {
  const declaredAgents: HarnessAgent[] = agents?.length ? agents : ['claude-code']

  const targets = manifest.structure === 'monorepo' ? ['.'] : [`apps/${projectName}-api`, `apps/${projectName}-web`]
  for (const targetPath of targets) {
    const targetManifestPath = targetPath === '.' ? '.saasfoundry.json' : `${targetPath}/.saasfoundry.json`
    const targetManifest = targetPath === '.' ? manifest : (JSON.parse(await readFile(targetManifestPath, 'utf8')) as SaaSFoundryManifest)
    const report = await installAgentInstructions({ targetPath, agents: declaredAgents, manifest: targetManifest })
    if (Object.keys(report.fileHashes).length > 0) {
      targetManifest.fileHashes = { ...targetManifest.fileHashes, ...report.fileHashes }
      await writeFile(targetManifestPath, JSON.stringify(targetManifest, null, 2))
      if (targetPath === '.') Object.assign(manifest, targetManifest)
    }
  }
}
