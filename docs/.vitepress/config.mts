import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'SaaSFoundryAI',
  description: 'AI-First SaaS Platform Generator',
  /**
   * Served from the root, not from a repository subpath.
   *
   * This said `/SaaSFoundryAI/` while the repository is `SaasFoundryAI` — a casing mismatch
   * nobody could have caught, because the site has never been deployed. Rather than fix the
   * casing and keep a subpath, `/` is the value that serves both things this documentation
   * is actually for: the copy bundled in the npm package, served from the root of a local
   * static server (#626), and a custom domain later. A `github.io/<repo>/` project site is
   * the only shape that would need the subpath back, and it is not the plan (#624).
   */
  base: '/',

  /**
   * Built outside `.vitepress/` so the output can ship in the npm package.
   *
   * `files` in package.json would have to name a path inside a dotted directory otherwise,
   * which is exactly the kind of packing edge case that fails quietly in a published
   * tarball and never locally (#626).
   */
  outDir: '../docs-dist',
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  vite: {
    server: {
      port: 5176
    }
  },

  // The tab icon is a THIRD asset on purpose: at 16px the S and F on the cube faces
  // stop being letters and start being dirt, so the favicon drops them. `icon.svg`
  // keeps them for the nav bar, where there is enough room to read them. See #567.
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]],

  markdown: {
    languageAlias: {
      env: 'bash'
    }
  },

  themeConfig: {
    logo: '/icon.svg',

    nav: [
      { text: 'Guide', link: '/guide/project-structure' },
      { text: 'CLI', link: '/cli/sf-new' },
      { text: 'Skills', link: '/skills/overview' },
      { text: 'Modules', link: '/modules/email' },
      { text: 'SRS', link: '/modules/srs' },
      {
        text: 'v1.0.0-beta',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing/development' }
        ]
      }
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Development Tools', link: '/getting-started/tools' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'First Project', link: '/getting-started/first-project' },
            { text: 'Shipping Your First Ticket', link: '/getting-started/shipping-first-ticket' }
          ]
        }
      ],

      '/cli/': [
        {
          text: 'CLI Commands',
          items: [
            // Ordered the way a project is lived: create it, change it, finish a setup
            // that stopped short, ask whether it can run — then the rest.
            { text: 'sf new', link: '/cli/sf-new' },
            { text: 'sf update', link: '/cli/sf-update' },
            { text: 'sf resume', link: '/cli/sf-resume' },
            { text: 'sf status', link: '/cli/sf-status' },
            { text: 'sf agents', link: '/cli/sf-agents' },
            { text: 'sf docs', link: '/cli/sf-docs' },
            { text: 'sf modules', link: '/cli/sf-modules' },
            { text: 'sf skill', link: '/cli/sf-skill' },
            { text: 'sf srs', link: '/cli/sf-srs' },
            { text: 'sf feedback', link: '/cli/sf-feedback' },
            { text: 'sf tools', link: '/cli/sf-tools' },
            { text: 'sf workflow', link: '/cli/sf-workflow' },
            { text: 'sf uninstall', link: '/cli/sf-uninstall' }
          ]
        }
      ],

      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Project Structure', link: '/guide/project-structure' },
            { text: 'Monorepo vs Multirepo', link: '/guide/monorepo-vs-multirepo' },
            { text: 'Agent Coexistence', link: '/guide/agent-coexistence' },
            { text: 'Execution Candidates', link: '/guide/execution-candidates' },
            { text: 'Workflow System', link: '/guide/workflow-system' },
            { text: 'Skills System', link: '/guide/skills-system' },
            { text: 'Module System', link: '/guide/module-system' },
            { text: 'Updating Projects', link: '/guide/updating-projects' }
          ]
        }
      ],

      '/skills/': [
        {
          text: 'Skills',
          items: [
            { text: 'Overview', link: '/skills/overview' },
            { text: 'Core Skills', link: '/skills/core-skills' },
            { text: 'Tool Skills', link: '/skills/tool-skills' },
            { text: 'Creating Skills', link: '/skills/creating-skills' }
          ]
        }
      ],

      '/modules/': [
        {
          text: 'Modules',
          items: [
            { text: 'Email', link: '/modules/email' },
            { text: 'Storage', link: '/modules/storage' },
            { text: 'Analytics', link: '/modules/analytics' },
            { text: 'Installable app (PWA)', link: '/modules/pwa' },
            { text: 'SRS', link: '/modules/srs' }
          ]
        }
      ],

      '/srs/': [
        {
          text: 'SRS',
          items: [
            { text: 'Module overview', link: '/modules/srs' },
            { text: 'Lifecycle', link: '/srs/lifecycle' },
            { text: 'Walkthrough', link: '/srs/walkthrough' },
            { text: 'Scanner findings', link: '/srs/scanner-findings' }
          ]
        }
      ],

      '/workflow/': [
        {
          text: 'Workflow System',
          items: [
            { text: 'Introduction', link: '/workflow/introduction' },
            { text: '7-Status System', link: '/workflow/7-status-system' },
            { text: 'Complexity System', link: '/workflow/complexity-system' },
            { text: 'AI Rules', link: '/workflow/ai-rules' },
            { text: 'GitHub Integration', link: '/workflow/github-integration' }
          ]
        }
      ],

      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Types', link: '/api/types' },
            { text: 'Builders', link: '/api/builders' },
            { text: 'Installers', link: '/api/installers' },
            { text: 'Runners', link: '/api/runners' }
          ]
        }
      ]
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/DiamondForgeFr/SaasFoundryAI' }],

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 DiamondForge'
    }
  }
})
