import { readFileSync } from 'fs'
import { join } from 'path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

// Regression guard for #286: the JSON Schema is the single source of truth
// for `.saasfoundry.json`. If a canonical shape from manifest-schema.md stops
// validating, scaffolded projects break — IDEs surface red squiggles where
// none should appear, and downstream skill scripts that trusted schema-pinned
// fields face values they don't expect.

const SCHEMA_PATH = join(__dirname, '../../../../schemas/saasfoundry-manifest.schema.json')
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

const baseManifest = {
  $schema: 'https://raw.githubusercontent.com/DiamondForgeFr/SaasFoundryAI/master/schemas/saasfoundry-manifest.schema.json',
  version: '1.0.0-beta',
  generatedAt: '2026-04-25T00:00:00.000Z',
  structure: 'multirepo',
  projectName: 'demo'
}

describe('saasfoundry-manifest.schema.json — canonical shapes', () => {
  it('accepts a minimal manifest (only required fields)', () => {
    expect(validate({ version: '1.0.0', structure: 'cli', projectName: 'demo' })).toBe(true)
  })

  // The schema is `additionalProperties: false` on `modules`, so every new module has to be
  // declared there or a project carrying it stops validating — IDE squiggles on a file the CLI
  // itself wrote.
  it('accepts the versioned pwa module', () => {
    expect(validate({ ...baseManifest, modules: { pwa: { version: 1 } } })).toBe(true)
  })

  it('rejects a pwa module without its version', () => {
    expect(validate({ ...baseManifest, modules: { pwa: {} } })).toBe(false)
  })

  it('rejects an undeclared module key', () => {
    expect(validate({ ...baseManifest, modules: { notAModule: { version: 1 } } })).toBe(false)
  })

  // The manifest is `additionalProperties: false` at the top level, so the language
  // block has to be declared here or the CLI writes a file its own schema rejects.
  it('accepts the language block', () => {
    expect(validate({ ...baseManifest, language: { srs: 'en', tickets: 'en', codeComments: 'fr' } })).toBe(true)
  })

  it('accepts a partial language block — absent surfaces resolve to English at read time', () => {
    expect(validate({ ...baseManifest, language: { srs: 'fr' } })).toBe(true)
  })

  it('accepts a manifest with no language block at all — the shape every existing project is in', () => {
    expect(validate(baseManifest)).toBe(true)
  })

  it('rejects an undeclared language surface', () => {
    expect(validate({ ...baseManifest, language: { readme: 'fr' } })).toBe(false)
  })

  it('accepts the full canonical shape from manifest-schema.md', () => {
    const full = {
      ...baseManifest,
      modules: {
        email: { provider: 'mailersend', version: 1 },
        s3Setup: 'docker',
        dbSetup: 'credentials',
        includeAnalytics: true,
        advancedSkills: ['context7', 'notion']
      },
      skillsAccounts: { context7: 'demo-account' },
      fileHashes: { 'src/main.ts': 'abc123' },
      workflow: {
        tool: 'github-projects',
        template: 'SaaSFoundry AI',
        projectUrl: 'https://github.com/orgs/demo/projects/1',
        workingBranch: 'develop',
        prTargetBranch: 'develop',
        releaseBranch: 'master',
        requireCodeReview: true,
        branchNaming: { feature: 'feature/{N}-{description}', fix: 'fix/{N}-{description}', release: 'rc-{version}' },
        commitFormat: { pattern: '<type>(#<ticket>): <description>', requireTicket: true, types: ['feat', 'fix'] },
        statuses: [
          { name: 'Backlog', color: 'GRAY' },
          { name: 'In progress', color: 'BLUE' }
        ],
        issueTypes: [{ name: 'sf-epic', description: 'Grouper', color: 'PURPLE' }, { name: 'sf-story', color: 'BLUE' }, { name: 'sf-task' }, { name: 'sf-issue', color: 'RED' }],
        validated: true,
        lastValidated: '2026-04-25T00:00:00.000Z'
      },
      aiRules: {
        alwaysCreateBranchFromWorking: true,
        alwaysCreateTicketBeforeCode: true,
        autoUpdateTicketStatus: false,
        requireHumanCheckOnPushedBranch: true
      },
      tools: {
        srs: {
          enabled: true,
          backend: 'notion',
          rootPage: { id: 'page-uuid', url: 'https://notion.so/x', name: 'My Epic' },
          scan: { exclude: ['scaffolds/', 'docs/'] }
        }
      }
    }
    expect(validate(full)).toBe(true)
  })

  it('accepts every structure enum value', () => {
    for (const structure of ['monorepo', 'multirepo', 'cli']) {
      expect(validate({ version: '1.0.0', structure, projectName: 'demo' })).toBe(true)
    }
  })

  it('accepts every workflow.tool enum value', () => {
    for (const tool of ['github-projects', 'jira', 'notion', 'linear', 'none']) {
      expect(validate({ ...baseManifest, workflow: { tool } })).toBe(true)
    }
  })

  it('accepts the tools-first selection registry (tracker/docs/design)', () => {
    const manifest = {
      ...baseManifest,
      tools: {
        srs: { enabled: true, backend: 'notion' },
        tracker: { name: 'github-projects' },
        docs: { name: 'notion', account: 'default' },
        design: [{ name: 'figma', account: 'work' }, { name: 'miro' }]
      }
    }
    expect(validate(manifest)).toBe(true)
  })

  it('still validates a manifest that omits the tools registry (backward compat)', () => {
    expect(validate({ ...baseManifest, tools: { srs: { enabled: false, backend: 'notion' } } })).toBe(true)
  })
})

describe('saasfoundry-manifest.schema.json — rejection cases', () => {
  it('rejects a manifest missing a required root field', () => {
    expect(validate({ version: '1.0.0', structure: 'cli' })).toBe(false)
  })

  it('rejects an unknown structure value', () => {
    expect(validate({ version: '1.0.0', structure: 'desktop', projectName: 'demo' })).toBe(false)
  })

  it('rejects an unknown workflow.tool value', () => {
    expect(validate({ ...baseManifest, workflow: { tool: 'azure-devops' } })).toBe(false)
  })

  it('rejects an unknown workflow.statuses[].color value', () => {
    expect(validate({ ...baseManifest, workflow: { tool: 'github-projects', statuses: [{ name: 'Done', color: 'NEON' }] } })).toBe(false)
  })

  it('rejects an unknown workflow.issueTypes[].color value', () => {
    expect(validate({ ...baseManifest, workflow: { tool: 'github-projects', issueTypes: [{ name: 'sf-epic', color: 'NEON' }] } })).toBe(false)
  })

  it('rejects a workflow.issueTypes[] entry missing the required name field', () => {
    expect(validate({ ...baseManifest, workflow: { tool: 'github-projects', issueTypes: [{ color: 'PURPLE' }] } })).toBe(false)
  })

  it('rejects a non-string tools.srs.backend (schema pins const "notion")', () => {
    // Guards the rationale for #291 — the bash script no longer needs a runtime
    // type check because non-string backend values are rejected at this layer.
    expect(validate({ ...baseManifest, tools: { srs: { enabled: true, backend: 42 } } })).toBe(false)
    expect(validate({ ...baseManifest, tools: { srs: { enabled: true, backend: 'jira' } } })).toBe(false)
  })

  it('rejects a typo in a top-level field (additionalProperties: false)', () => {
    expect(validate({ ...baseManifest, structuer: 'cli' })).toBe(false)
  })

  it('rejects a tools.tracker selection missing the required name field', () => {
    expect(validate({ ...baseManifest, tools: { tracker: { account: 'default' } } })).toBe(false)
  })

  it('rejects an unknown property on a tool selection (additionalProperties: false)', () => {
    expect(validate({ ...baseManifest, tools: { docs: { name: 'notion', connection: 'ok' } } })).toBe(false)
  })

  it('rejects tools.design when it is not an array of selections', () => {
    expect(validate({ ...baseManifest, tools: { design: { name: 'figma' } } })).toBe(false)
  })
})

describe('shared harness agent inventory', () => {
  it('accepts legacy and additive agent configurations', () => {
    for (const harness of [{ version: 1 }, { version: 1, agents: ['claude-code', 'codex', 'kimi'] }]) {
      expect(validate({ ...baseManifest, modules: { harness } })).toBe(true)
    }
  })

  it('rejects empty, duplicated, and unsupported agent inventories', () => {
    for (const agents of [[], ['codex', 'codex'], ['gpt']]) {
      expect(validate({ ...baseManifest, modules: { harness: { version: 1, agents } } })).toBe(false)
    }
  })
})
