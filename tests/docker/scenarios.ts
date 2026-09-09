// ── Test Scenario Definitions ──────────────────────────────────
// Each scenario defines a project configuration to generate and validate.
// ALL_SCENARIOS is ordered by PRIORITY — first scenarios are the most critical.
// This allows `--count N` to run the N most important scenarios.

export type ScenarioType = 'generation' | 'update' | 'ai' | 'migration' | 'cli' | 'boot'

export interface GenerationScenario {
  type: 'generation'
  name: string
  projectName: string
  isMonorepo: boolean
  dbSetup: 'docker' | 'credentials' | 'manual'
  s3Setup: 'docker' | 'credentials' | 'manual'
  emailService: 'none' | 'mailersend'
  includeAnalytics: boolean
  /** Optional so the 19 existing scenarios keep their shape; only the PWA scenario opts in. */
  includePwa?: boolean
  /** Exercise the emitted OpenAPI -> generated client contract after the normal build. */
  validateApiContract?: boolean
  /** Reject critical advisories across every generated npm workspace. */
  auditDependencies?: boolean
}

export interface UpdateScenario {
  type: 'update'
  name: string
  /** Base generation config (always minimal) */
  base: Omit<GenerationScenario, 'type' | 'name'>
  /** Modules to add after initial generation */
  addModules: {
    email?: boolean
    storage?: boolean
    analytics?: boolean
  }
}

export interface AIScenario {
  type: 'ai'
  name: string
  projectName: string
  isMonorepo: boolean
  /** What to verify (no builds needed) */
  checks: ('skills' | 'claude-md' | 'workflow')[]
}

/**
 * Migration scenario — exercises the manifest migration framework end-to-end.
 *
 * Generates a project, hand-writes a legacy v0-shape manifest (no $schema, no
 * manifestVersion), runs `sf update` and asserts the dispatcher upgrades the
 * file in place. Catches integration bugs that pure unit tests can't see —
 * e.g. early-return paths in update.ts that skip the persistence step.
 */
export interface MigrationScenario {
  type: 'migration'
  name: string
  projectName: string
  isMonorepo: boolean
}

/**
 * CLI scenario — runs `sf new` as a real subprocess.
 *
 * Every other scenario type reaches into the CLI: the generation ones call the builders
 * directly and create the project directory themselves, and the migration one imports
 * `updateCommand`. So `bin/sf.js`, Commander, and the non-interactive flag validation are
 * exercised by nothing — and neither is anything `sf new` does before it delegates: the
 * profile branch, creating the project directory, choosing where to put it, writing the
 * manifest.
 *
 * That is why "the project folder is created alongside, not inside" (#537) had no coverage
 * and had to be checked by hand. This type exists so the command is executed rather than
 * reproduced.
 */
export interface CliScenario {
  type: 'cli'
  name: string
  /** Project name passed to the command. For `harness`, no directory of this name may appear. */
  projectName: string
  profile: 'full' | 'harness'
  isMonorepo: boolean
  /**
   * Include this scenario in the quick lane (PR → develop) on top of the top-N by priority.
   * Reserved for scenarios that are both cheap and guard something damaging.
   */
  quick?: boolean
}

/**
 * Boot scenario — the only one that runs the generated project instead of compiling it.
 *
 * Everything else in this file stops at `tsc -b` / `nest build` / `vite build`. A build is
 * the one check that cannot see a module that throws on load, which is how #591 shipped:
 * `@nestjs/swagger` emitted `enum: string`, every generated API died at startup, and
 * twenty-two scenarios were green. #589 and #592 end the same way — an application that
 * does not start — and a single request to /api/health catches all three.
 *
 * One scenario, not all of them. The build matrix is good at topology and modules; adding
 * a boot to each would multiply a seventy-minute suite for no extra signal.
 *
 * Multirepo remains useful here because it boots both independently installed apps. The
 * generation matrix separately audits a monorepo, where shared packages can carry
 * advisories that do not exist in this topology.
 */
export interface BootScenario {
  type: 'boot'
  name: string
  projectName: string
  /** Seconds to wait for each server to answer before calling it dead. */
  bootTimeoutSeconds: number
  quick?: boolean
}

export type TestScenario = GenerationScenario | UpdateScenario | AIScenario | MigrationScenario | CliScenario | BootScenario

// ── ALL SCENARIOS — ordered by priority ────────────────────────
// Priority rationale:
//   1-2: Minimal builds (catch fundamental breakage fast)
//   3-4: Full builds (all modules combined)
//   5-6: Update flows (module addition still compiles)
//   7-9: AI config (no build, structural only — fast)
//  10-12: Single module variations
//  13-14: Module combos
//  15-16: Monorepo module combos
//  17-18: Remaining update flows

export const ALL_SCENARIOS: TestScenario[] = [
  // ── Priority 1-2: Minimal builds ──────────────────────────────
  {
    type: 'generation',
    name: 'multirepo-minimal',
    projectName: 'multi-min',
    isMonorepo: false,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: false
  },
  {
    type: 'generation',
    name: 'monorepo-minimal',
    projectName: 'mono-min',
    isMonorepo: true,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: false,
    validateApiContract: true,
    auditDependencies: true
  },

  // ── Priority 3-4: Full builds (all modules) ──────────────────
  {
    type: 'generation',
    name: 'multirepo-full',
    projectName: 'multi-full',
    isMonorepo: false,
    dbSetup: 'docker',
    s3Setup: 'docker',
    emailService: 'mailersend',
    includeAnalytics: true
  },
  {
    type: 'generation',
    name: 'monorepo-full',
    projectName: 'mono-full',
    isMonorepo: true,
    dbSetup: 'docker',
    s3Setup: 'docker',
    emailService: 'mailersend',
    includeAnalytics: true,
    validateApiContract: true
  },

  // ── Priority 5-6: Update flows (most complex) ────────────────
  {
    type: 'update',
    name: 'update-add-all-modules',
    base: {
      projectName: 'upd-all',
      isMonorepo: true,
      dbSetup: 'manual',
      s3Setup: 'manual',
      emailService: 'none',
      includeAnalytics: false
    },
    addModules: { email: true, storage: true, analytics: true }
  },
  {
    type: 'update',
    name: 'update-add-email',
    base: {
      projectName: 'upd-email',
      isMonorepo: false,
      dbSetup: 'manual',
      s3Setup: 'manual',
      emailService: 'none',
      includeAnalytics: false
    },
    addModules: { email: true }
  },

  // ── Priority 7-9: AI config (fast, no build) ─────────────────
  {
    type: 'ai',
    name: 'ai-multirepo-skills',
    projectName: 'ai-multi',
    isMonorepo: false,
    checks: ['skills', 'claude-md']
  },
  {
    type: 'ai',
    name: 'ai-monorepo-skills',
    projectName: 'ai-mono',
    isMonorepo: true,
    checks: ['skills', 'claude-md']
  },
  {
    type: 'ai',
    name: 'ai-workflow-config',
    projectName: 'ai-wf',
    isMonorepo: false,
    checks: ['workflow', 'claude-md']
  },

  // ── Migration framework E2E (Epic #310) ──────────────────────
  {
    type: 'migration',
    name: 'migration-v0-to-current',
    projectName: 'mig-v0',
    isMonorepo: false
  },

  // ── Priority 10-12: Single module variations ──────────────────
  {
    type: 'generation',
    name: 'multirepo-email-only',
    projectName: 'multi-email',
    isMonorepo: false,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'mailersend',
    includeAnalytics: false
  },
  {
    type: 'generation',
    name: 'multirepo-storage-only',
    projectName: 'multi-storage',
    isMonorepo: false,
    dbSetup: 'docker',
    s3Setup: 'docker',
    emailService: 'none',
    includeAnalytics: false
  },
  {
    type: 'generation',
    name: 'multirepo-analytics-only',
    projectName: 'multi-analytics',
    isMonorepo: false,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: true
  },

  // ── Priority 13-14: Module combos ─────────────────────────────
  {
    type: 'generation',
    name: 'multirepo-email-storage',
    projectName: 'multi-es',
    isMonorepo: false,
    dbSetup: 'docker',
    s3Setup: 'credentials',
    emailService: 'mailersend',
    includeAnalytics: false
  },
  {
    type: 'generation',
    name: 'monorepo-email-analytics',
    projectName: 'mono-ea',
    isMonorepo: true,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'mailersend',
    includeAnalytics: true
  },

  // ── Priority 15-16: Monorepo module combos ────────────────────
  {
    type: 'generation',
    name: 'monorepo-storage-analytics',
    projectName: 'mono-sa',
    isMonorepo: true,
    dbSetup: 'docker',
    s3Setup: 'docker',
    emailService: 'none',
    includeAnalytics: true
  },
  {
    type: 'update',
    name: 'update-add-email-monorepo',
    base: {
      projectName: 'upd-email-mono',
      isMonorepo: true,
      dbSetup: 'manual',
      s3Setup: 'manual',
      emailService: 'none',
      includeAnalytics: false
    },
    addModules: { email: true }
  },

  // ── Priority 17-18: Remaining update flows ────────────────────
  {
    type: 'update',
    name: 'update-add-storage',
    base: {
      projectName: 'upd-storage',
      isMonorepo: false,
      dbSetup: 'manual',
      s3Setup: 'manual',
      emailService: 'none',
      includeAnalytics: false
    },
    addModules: { storage: true }
  },
  {
    type: 'update',
    name: 'update-add-analytics',
    base: {
      projectName: 'upd-analytics',
      isMonorepo: false,
      dbSetup: 'manual',
      s3Setup: 'manual',
      emailService: 'none',
      includeAnalytics: false
    },
    addModules: { analytics: true }
  },

  // ── PWA: the app must still build, and must emit the installable artefacts ──
  {
    type: 'generation',
    name: 'multirepo-pwa',
    projectName: 'multi-pwa',
    isMonorepo: false,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: false,
    includePwa: true
  },

  // ── The CLI itself, run as a subprocess ───────────────────────
  // `harness` first: it is the fast one and the damaging one. Getting it wrong scaffolds a
  // full stack over a repository the user intends to keep (#510).
  {
    type: 'cli',
    name: 'cli-new-harness',
    projectName: 'should-not-exist',
    profile: 'harness',
    isMonorepo: true,
    quick: true
  },
  {
    type: 'cli',
    name: 'cli-new-placement',
    projectName: 'placed-project',
    profile: 'full',
    isMonorepo: true
  },

  // ── The one that starts the thing ─────────────────────────────
  // `quick` on purpose, expensive as it is. The full lane only runs on PR → master, and
  // #591 was merged to develop and found by a user three days later — a boot check that
  // does not run on PR → develop would not have caught the thing it was built for.
  {
    type: 'boot',
    name: 'multirepo-boot-and-test',
    projectName: 'boot-check',
    bootTimeoutSeconds: 180,
    quick: true
  }
]

export function getScenario(name: string): TestScenario {
  const scenario = ALL_SCENARIOS.find((s) => s.name === name)
  if (!scenario) {
    const available = ALL_SCENARIOS.map((s) => s.name).join(', ')
    throw new Error(`Unknown scenario "${name}". Available: ${available}`)
  }
  return scenario
}

export function getScenariosByType<T extends ScenarioType>(type: T): Extract<TestScenario, { type: T }>[] {
  return ALL_SCENARIOS.filter((s) => s.type === type) as Extract<TestScenario, { type: T }>[]
}

/** Get the first N scenarios (by priority order) */
export function getTopScenarios(count: number): TestScenario[] {
  return ALL_SCENARIOS.slice(0, Math.min(count, ALL_SCENARIOS.length))
}

/**
 * The quick lane: the top N by priority, plus any scenario that opts in with `quick`.
 *
 * Exists so the CI workflow can ask this file which scenarios to run instead of carrying
 * its own copy of the list. A hand-written copy is what let `migration-v0-to-current` and
 * `multirepo-pwa` be defined and never run on any pull request — the same drift #426 fixed
 * for `--list` and that never reached the workflow.
 */
export function getQuickScenarios(count: number): TestScenario[] {
  const top = getTopScenarios(count)
  const opted = ALL_SCENARIOS.filter((s) => 'quick' in s && s.quick === true && !top.includes(s))
  return [...top, ...opted]
}
