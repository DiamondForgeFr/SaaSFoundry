import { defineConfig } from 'orval'

/**
 * Orval codegen configuration.
 *
 * Source of truth: apps/api/docs/openapi.json — the snapshot emitted by
 * `apps/api` at boot time (via @nestjs/swagger + nestjs-zod cleanupOpenApiDoc).
 *
 * Output:
 *   - src/generated/api/<tag>/<tag>.ts       — typed React Query hooks per tag
 *   - src/generated/api/model/*.ts           — shared TS models
 *
 * Hook factory: see ./src/http-client.ts (orval mutator). It wraps the
 * existing fetch-based client so cookie auth + 401 handling are preserved.
 */
export default defineConfig({
  api: {
    input: {
      target: '../../apps/api/docs/openapi.json'
    },
    output: {
      mode: 'tags-split',
      target: './src/generated/api',
      schemas: './src/generated/api/model',
      client: 'react-query',
      // Orval 8 defaults to fetch. Keep the axios-shaped request object because
      // apiClientMutator owns the actual Fetch transport and consumes this shape.
      httpClient: 'axios',
      clean: true,
      prettier: true,
      override: {
        // Preserve the named oneOf/anyOf/allOf aliases emitted by Orval 7 so
        // upgrading the generator does not remove public model exports.
        aliasCombinedTypes: true,
        mutator: {
          path: './src/http-client.ts',
          name: 'apiClientMutator'
        },
        query: {
          signal: true
        }
      }
    },
    hooks: {
      afterAllFilesWrite: 'prettier --write'
    }
  }
})
