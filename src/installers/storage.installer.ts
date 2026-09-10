import { copy } from 'fs-extra'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'

import type { ModuleInstaller } from '../migrations/module/types'
import { overlaysPath, S3Credentials } from '../types'
import { fileExists, getNvmPrefix } from '../utils'
import { runRequired } from '../run'

export const storageInstallerMeta: ModuleInstaller = {
  name: 'storage',
  currentVersion: 1,
  migrations: []
}

interface InstallStorageModuleParams {
  apiPath: string
  webPath: string
  isMonorepo: boolean
  projectName: string
  s3Setup: 'docker' | 'credentials' | 'manual'
  s3Credentials?: S3Credentials
  skipNpmInstall?: boolean
  /**
   * Resolved host port for a Docker MinIO. Absent means 9000, which is what projects
   * generated before #623 run on.
   *
   * This is the same defect #583 fixed on the database: the published port moved and the
   * `.env` kept the default, so the app dialled a port nothing was listening on. Writing
   * the endpoint from the resolved value is the whole point of resolving it.
   */
  s3Port?: number
}

/**
 * Install the S3 storage module on API + Web apps.
 *
 * This function:
 * 1. Copies the storage overlay module to the API app
 * 2. Adds @aws-sdk/client-s3 and @types/multer dependencies to API package.json
 * 3. Runs npm install (unless monorepo or skipNpmInstall)
 * 4. Uncomments `// TODO storage-service-active:` markers in every file of STORAGE_GATED_FILES
 * 5. Updates API .env and .env.test with S3 credentials
 * 6. Sets VITE_STORAGE_ENABLED=true in web .env
 * 7. (Mono only) Deposits MIME/size constants in `packages/shared-config` and
 *    rewires the org controller to consume them — gated on the workspace's
 *    presence (no-op early in `sf new`; replayed by `new.ts` after
 *    `createMonorepoRoot`).
 *
 * Used by both `sf new` (during initial project generation) and `sf update` (when adding the module later).
 */

/** Files whose storage code the blueprint ships commented out behind `STORAGE_MARKER`. */
const STORAGE_GATED_FILES = [
  'src/configs/env/services/env.service.ts',
  'src/app.module.ts',
  'src/modules/organizations/organizations.module.ts',
  'src/modules/organizations/controllers/organization.controller.ts',
  'src/modules/organizations/services/organization.service.ts',
  // The one that was missing. A spec is not exempt: it imports the same module, and it is
  // the only place a user runs code the build never compiles.
  'src/modules/organizations/tests/unit/organization.service.spec.ts'
]

const STORAGE_MARKER = /\/\/ TODO storage-service-active: /g
const STORAGE_PARAMETER_MARKER = /\n(\s*)\/\/ TODO storage-service-active-parameter: /g

async function activateStorageCode(apiPath: string): Promise<void> {
  for (const relative of STORAGE_GATED_FILES) {
    const path = `${apiPath}/${relative}`
    if (!(await fileExists(path))) continue
    const content = await readFile(path, 'utf8')
    await writeFile(path, content.replace(STORAGE_PARAMETER_MARKER, ',\n$1').replace(STORAGE_MARKER, ''))
  }
}

export async function installStorageModule({ apiPath, webPath, isMonorepo, projectName, s3Setup, s3Credentials, skipNpmInstall, s3Port }: InstallStorageModuleParams) {
  // Copy storage overlay module to the API
  const storageOverlayPath = resolve(overlaysPath, 'modules/storage')
  const apiStoragePath = `${apiPath}/src/modules/storage`
  await copy(storageOverlayPath, apiStoragePath)

  // Add @aws-sdk/client-s3 dependency and @types/multer for file uploads
  const pkgPath = `${apiPath}/package.json`
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.dependencies['@aws-sdk/client-s3'] = '3.1123.0'
  pkg.devDependencies['@types/multer'] = '2.2.0'
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  // Register multer in tsconfig types so @types/multer is picked up under explicit types[]
  // Defensive: create compilerOptions/types if absent so manual edits to tsconfig don't silently skip the registration.
  const tsconfigPath = `${apiPath}/tsconfig.json`
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'))
  tsconfig.compilerOptions ??= {}
  tsconfig.compilerOptions.types ??= ['node', 'jest']
  if (!tsconfig.compilerOptions.types.includes('multer')) {
    tsconfig.compilerOptions.types.push('multer')
    await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n')
  }

  // Run npm install (unless monorepo handles it or explicitly skipped)
  if (!isMonorepo && !skipNpmInstall) {
    const nvm = getNvmPrefix(apiPath)
    runRequired('npm install (storage module)', `${nvm}npm install --prefix ${apiPath}`)
  }

  // Activate the storage code the blueprint keeps commented out.
  //
  // One list rather than four near-identical read/replace/write blocks: the spec below was
  // missing from those blocks, so a project that declined storage shipped a unit suite
  // importing a module it did not have — and `tsconfig.build.json` excludes `**/*spec.ts`,
  // so no build could see it (#610). A file forgotten here is invisible until someone runs
  // the tests, which is exactly the gap #594 exists to close.
  await activateStorageCode(apiPath)

  // Determine S3 credentials
  const s3Endpoint = s3Setup === 'docker' ? `http://localhost:${s3Port ?? 9000}` : s3Credentials?.endpoint || ''
  const s3AccessKey = s3Setup === 'docker' ? 'minioadmin' : s3Credentials?.accessKey || ''
  const s3SecretKey = s3Setup === 'docker' ? 'minioadmin' : s3Credentials?.secretKey || ''
  const s3Bucket = s3Credentials?.bucket || `${projectName}-uploads`
  const s3Region = s3Credentials?.region || 'us-east-1'

  // Update API .env with S3 credentials
  const envPath = `${apiPath}/.env`
  if (await fileExists(envPath)) {
    let envContent = await readFile(envPath, 'utf8')
    envContent = envContent
      .replace(/# S3_ENDPOINT=.*$/m, `S3_ENDPOINT="${s3Endpoint}"`)
      .replace(/# S3_ACCESS_KEY=.*$/m, `S3_ACCESS_KEY="${s3AccessKey}"`)
      .replace(/# S3_SECRET_KEY=.*$/m, `S3_SECRET_KEY="${s3SecretKey}"`)
      .replace(/# S3_BUCKET=.*$/m, `S3_BUCKET="${s3Bucket}"`)
      .replace(/# S3_REGION=.*$/m, `S3_REGION="${s3Region}"`)
    await writeFile(envPath, envContent)
  }

  // Update API .env.test with S3 test credentials
  const envTestPath = `${apiPath}/.env.test`
  if (await fileExists(envTestPath)) {
    let envTestContent = await readFile(envTestPath, 'utf8')
    envTestContent = envTestContent
      .replace(/# S3_ENDPOINT=.*$/m, `S3_ENDPOINT="http://localhost:${s3Port ?? 9000}"`)
      .replace(/# S3_ACCESS_KEY=.*$/m, `S3_ACCESS_KEY="minioadmin"`)
      .replace(/# S3_SECRET_KEY=.*$/m, `S3_SECRET_KEY="minioadmin"`)
      .replace(/# S3_BUCKET=.*$/m, `S3_BUCKET="test-uploads"`)
      .replace(/# S3_REGION=.*$/m, `S3_REGION="us-east-1"`)
    await writeFile(envTestPath, envTestContent)
  }

  // Update web .env to enable storage
  const webEnvPath = `${webPath}/.env`
  if (await fileExists(webEnvPath)) {
    let webEnvContent = await readFile(webEnvPath, 'utf8')
    webEnvContent = webEnvContent.replace(/VITE_STORAGE_ENABLED=.*$/m, 'VITE_STORAGE_ENABLED="true"')
    await writeFile(webEnvPath, webEnvContent)
  }

  // Mono-only: deposit MIME/size constants into @<proj>/shared-config and
  // rewire the controller. Gated on the workspace's presence: in `sf new` mono
  // flow, `createApiApp` runs BEFORE `createMonorepoRoot` lays down
  // `packages/shared-config/`, so this is a no-op the first time. `new.ts`
  // calls `depositStorageSharedConfig` again after the root overlay runs.
  // In `sf update` the workspace already exists, so it deposits in one pass.
  if (isMonorepo) {
    await depositStorageSharedConfig({ apiPath, projectName })
  }
}

interface DepositStorageSharedConfigParams {
  apiPath: string
  projectName: string
}

/**
 * Idempotent deposit of `STORAGE_LOGO_*` constants into the monorepo
 * shared-config workspace + controller rewire to consume them.
 *
 * No-ops when:
 * - `packages/shared-config/src/` doesn't exist (mono root not yet created)
 * - the org controller still has `// TODO storage-service-active:` markers
 *   (storage hasn't been activated yet — the rewire targets the uncommented
 *   live code only)
 *
 * Multirepo never calls this — it keeps the inlined literals per side.
 */
export async function depositStorageSharedConfig({ apiPath, projectName }: DepositStorageSharedConfigParams): Promise<void> {
  const monorepoRoot = resolve(apiPath, '..', '..')
  const sharedConfigDir = `${monorepoRoot}/packages/shared-config/src`
  if (!existsSync(sharedConfigDir)) return

  // Storage activation gate — only deposit when the storage module has been
  // installed (markers uncommented). Otherwise the shared-config workspace
  // would carry a dangling `storage.ts` even on storage-less projects.
  const orgControllerPath = `${apiPath}/src/modules/organizations/controllers/organization.controller.ts`
  if (!existsSync(orgControllerPath)) return
  let orgControllerContent = await readFile(orgControllerPath, 'utf8')
  if (orgControllerContent.includes('// TODO storage-service-active:')) return

  const storageFile = `${sharedConfigDir}/storage.ts`
  await writeFile(
    storageFile,
    [
      '/**',
      ' * Logo upload contract — shared by apps/api (FileInterceptor) and any future',
      ' * apps/web preview/validation. Multirepo equivalents are inlined per side.',
      ' */',
      'export const STORAGE_LOGO_MAX_BYTES = 5 * 1024 * 1024',
      "export const STORAGE_LOGO_ALLOWED_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']",
      ''
    ].join('\n')
  )

  const indexPath = `${sharedConfigDir}/index.ts`
  const indexContent = await readFile(indexPath, 'utf8')
  if (!indexContent.includes("from './storage'")) {
    await writeFile(indexPath, `${indexContent.replace(/\s*$/, '')}\nexport * from './storage'\n`)
  }

  const importLine = `import { STORAGE_LOGO_ALLOWED_MIMES, STORAGE_LOGO_MAX_BYTES } from '@${projectName}/shared-config'\n`
  if (!orgControllerContent.includes(importLine)) {
    orgControllerContent = orgControllerContent.replace(`import { FileInterceptor } from '@nestjs/platform-express'\n`, `import { FileInterceptor } from '@nestjs/platform-express'\n${importLine}`)
  }
  orgControllerContent = orgControllerContent
    .replace('fileSize: 5 * 1024 * 1024', 'fileSize: STORAGE_LOGO_MAX_BYTES')
    .replace(`const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']`, `const allowedMimes = STORAGE_LOGO_ALLOWED_MIMES`)
  await writeFile(orgControllerPath, orgControllerContent)
}
