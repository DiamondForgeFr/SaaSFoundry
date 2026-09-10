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
  const harness = manifest.modules?.harness
  if (!harness) throw new Error('Cannot project multirepo agent manifests without a harness declaration.')

  for (const appName of [`${projectName}-api`, `${projectName}-web`]) {
    const projection: SaaSFoundryManifest = {
      $schema: manifest.$schema,
      manifestVersion: manifest.manifestVersion,
      version: manifest.version,
      generatedAt: manifest.generatedAt,
      // Each app is a complete Git checkout and an independent harness root.
      // `cli` deliberately keeps `sf update` out of scaffold regeneration; the
      // outer multirepo manifest remains the stack-generation coordinator.
      structure: 'cli',
      projectName: appName,
      mainBranch: manifest.mainBranch,
      modules: {
        harness,
        advancedSkills: manifest.modules?.advancedSkills ?? []
      },
      language: manifest.language,
      workflow: manifest.workflow,
      aiRules: manifest.aiRules,
      tools: manifest.tools,
      fileHashes: {}
    }
    await mkdir(`apps/${appName}`, { recursive: true })
    await writeFile(`apps/${appName}/.saasfoundry.json`, JSON.stringify(projection, null, 2))
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
