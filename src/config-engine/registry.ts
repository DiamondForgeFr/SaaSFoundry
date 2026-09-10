import { analyticsStep } from './steps/analytics.step'
import { agentsStep } from './steps/agents.step'
import { pwaStep } from './steps/pwa.step'
import { emailCredentialsStep } from './steps/email-credentials.step'
import { harnessProjectStep } from './steps/harness-project.step'
import { languageStep } from './steps/language.step'
import { profileStep } from './steps/profile.step'
import { projectStep } from './steps/project.step'
import { skillsStep } from './steps/skills.step'
import { srsStep } from './steps/srs.step'
import { storageStep } from './steps/storage.step'
import { toolsStep } from './steps/tools.step'
import { workflowStep } from './steps/workflow.step'
import { StepDefinition } from './types'

/**
 * Ordered list of the steps composing the `sf new` collection session —
 * order is the user-facing question order, so changes here are behaviour
 * changes.
 */
export const configSteps: StepDefinition[] = [
  profileStep,
  agentsStep,
  projectStep,
  harnessProjectStep,
  emailCredentialsStep,
  storageStep,
  analyticsStep,
  pwaStep,
  toolsStep,
  workflowStep,
  languageStep,
  skillsStep,
  srsStep
]

/**
 * Structural sanity checks, same spirit as the manifest-migration registry
 * contiguity assertions: fail fast at session start instead of producing a
 * half-collected config.
 */
export function assertStepRegistry(steps: StepDefinition[]): void {
  const stepIds = new Set<string>()
  const fieldOwners = new Map<string, string>()

  for (const step of steps) {
    if (!step.id) {
      throw new Error('config-engine: every step needs a non-empty id')
    }
    if (stepIds.has(step.id)) {
      throw new Error(`config-engine: duplicate step id "${step.id}"`)
    }
    stepIds.add(step.id)

    if (!step.fields?.length && !step.collect) {
      throw new Error(`config-engine: step "${step.id}" declares neither fields nor collect`)
    }

    // Duplicate field names within one step are legal (mutually exclusive
    // `when` variants, e.g. setupRepo). Across steps they would silently
    // overwrite an earlier answer — fail fast.
    const ownFields = new Set((step.fields ?? []).map((f) => f.name))
    for (const name of ownFields) {
      const owner = fieldOwners.get(name)
      if (owner !== undefined && owner !== step.id) {
        throw new Error(`config-engine: field "${name}" is declared by both "${owner}" and "${step.id}"`)
      }
      fieldOwners.set(name, step.id)
    }
  }
}
