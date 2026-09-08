import registryData from './agent-profiles.json'

/** Literal IDs come from JSON keys, never a second hand-maintained union. */
export type HarnessAgent = keyof typeof registryData.profiles

export interface AgentProfile {
  id: HarnessAgent
  displayName: string
  instructionFile: string
  sharedInstructions: boolean
  instructions: 'documented' | 'manual'
  skills: 'documented' | 'manual' | 'not-checked'
  runtime: 'not-checked'
  sources: string[]
  limitations: string[]
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = ['displayName', 'instructionFile', 'sharedInstructions', 'instructions', 'skills', 'runtime', 'sources', 'limitations']
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)

/** Validate bundled declarative data; no commands, loaders or arbitrary paths. */
export function validateAgentRegistry(value: unknown): void {
  if (
    !object(value) ||
    value.registryVersion !== 1 ||
    Object.keys(value).some((key) => !['registryVersion', 'profiles'].includes(key)) ||
    !object(value.profiles) ||
    Object.keys(value.profiles).length === 0
  ) {
    throw new Error('Invalid agent registry: expected registryVersion 1 and built-in profiles.')
  }
  for (const [id, profile] of Object.entries(value.profiles)) {
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) ||
      !object(profile) ||
      Object.keys(profile).length !== fields.length ||
      fields.some((field) => !Object.prototype.hasOwnProperty.call(profile, field)) ||
      Object.keys(profile).some((field) => !fields.includes(field))
    ) {
      throw new Error(`Invalid declarative agent profile: ${id}`)
    }
    if (
      typeof profile.displayName !== 'string' ||
      !profile.displayName.trim() ||
      typeof profile.instructionFile !== 'string' ||
      !/^[A-Z][A-Z0-9_-]*\.md$/.test(profile.instructionFile) ||
      typeof profile.sharedInstructions !== 'boolean' ||
      typeof profile.instructions !== 'string' ||
      !['documented', 'manual'].includes(profile.instructions) ||
      typeof profile.skills !== 'string' ||
      !['documented', 'manual', 'not-checked'].includes(profile.skills) ||
      profile.runtime !== 'not-checked' ||
      !strings(profile.sources) ||
      !strings(profile.limitations)
    ) {
      throw new Error(`Invalid agent capability declaration: ${id}`)
    }
    for (const source of profile.sources) {
      let url: URL
      try {
        url = new URL(source)
      } catch {
        throw new Error(`Invalid profile source URL: ${id}`)
      }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Unsafe profile source URL: ${id}`)
    }
    if ((profile.instructions === 'documented' || profile.skills === 'documented') && profile.sources.length === 0) throw new Error(`Documented profile requires a source: ${id}`)
    if (profile.sharedInstructions && profile.instructionFile === 'CLAUDE.md') throw new Error(`Shared profile cannot replace the canonical Claude entrypoint: ${id}`)
  }
}

validateAgentRegistry(registryData)
export const AGENT_REGISTRY_VERSION = registryData.registryVersion
// Freeze an independent snapshot so imported JSON mutations cannot change behavior.
const profiles = Object.freeze(
  Object.fromEntries(
    Object.entries(registryData.profiles).map(([id, value]) => [
      id,
      Object.freeze({
        ...value,
        id,
        sources: Object.freeze([...value.sources]),
        limitations: Object.freeze([...value.limitations])
      })
    ])
  )
) as Readonly<Record<HarnessAgent, Readonly<Omit<AgentProfile, 'sources' | 'limitations'> & { readonly sources: readonly string[]; readonly limitations: readonly string[] }>>>

export function getAgentIds(): HarnessAgent[] {
  return Object.keys(profiles) as HarnessAgent[]
}

export function isHarnessAgent(value: unknown): value is HarnessAgent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(profiles, value)
}

export function getAgentProfile(id: string): AgentProfile {
  if (!isHarnessAgent(id)) throw new Error(`Unknown coding agent '${id}'. Supported profiles: ${getAgentIds().join(', ')}. Model names and providers are separate.`)
  const profile = profiles[id]
  return { ...profile, sources: [...profile.sources], limitations: [...profile.limitations] }
}

export function listAgentProfiles(): AgentProfile[] {
  return getAgentIds().map(getAgentProfile)
}

export function needsSharedInstructions(ids: string[]): boolean {
  // Validate every requested ID even if an earlier profile already needs a bridge.
  return ids.map(getAgentProfile).some((profile) => profile.sharedInstructions)
}

export function getSharedAgentEntrypoints(): string[] {
  return [
    ...new Set(
      listAgentProfiles()
        .filter((profile) => profile.sharedInstructions && profile.instructionFile !== 'CLAUDE.md')
        .map((profile) => profile.instructionFile)
    )
  ]
}
