import { copy } from 'fs-extra'
import { rm } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import shelljs from 'shelljs'

import { installStorageModule } from '../../../installers/storage.installer'
import { blueprintsPath, overlaysPath } from '../../../types'
import { expectFileExists, expectFileContains, expectNoTodoMarkers, expectEnvVar, expectPackageJsonDep } from '../../helpers/assertions'

describe('installStorageModule (integration)', () => {
  let tempDir: string
  let apiPath: string
  let webPath: string
  let shellSpy: jest.SpyInstance

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-storage-test-${Date.now()}`)
    apiPath = join(tempDir, 'apps/test-project-api')
    webPath = join(tempDir, 'apps/test-project-web')

    // Copy the full API and Web blueprints + multirepo overlays (for package.json) to temp dir
    await copy(resolve(blueprintsPath, 'api'), apiPath)
    await copy(resolve(overlaysPath, 'multirepo/api'), apiPath, { overwrite: true })
    await copy(resolve(blueprintsPath, 'web'), webPath)
    await copy(resolve(overlaysPath, 'multirepo/web'), webPath, { overwrite: true })

    // Mock shelljs.exec to prevent npm install
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shellSpy = jest.spyOn(shelljs, 'exec').mockImplementation((() => ({ code: 0, stdout: '', stderr: '' })) as any)
  })

  afterEach(async () => {
    shellSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('should copy storage overlay module to API', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectFileExists(join(apiPath, 'src/modules/storage'))
  })

  it('should add @aws-sdk/client-s3 to API package.json dependencies', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectPackageJsonDep(join(apiPath, 'package.json'), '@aws-sdk/client-s3')
  })

  it('should add @types/multer to API package.json devDependencies', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectPackageJsonDep(join(apiPath, 'package.json'), '@types/multer', 'devDependencies')
  })

  it('should uncomment storage-service-active markers in env.service.ts', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectNoTodoMarkers(join(apiPath, 'src/configs/env/services/env.service.ts'), 'storage-service-active')
  })

  it('should uncomment storage-service-active markers in app.module.ts', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectNoTodoMarkers(join(apiPath, 'src/app.module.ts'), 'storage-service-active')
  })

  it('should uncomment storage-service-active markers in organization files', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectNoTodoMarkers(join(apiPath, 'src/modules/organizations/organizations.module.ts'), 'storage-service-active')
    await expectNoTodoMarkers(join(apiPath, 'src/modules/organizations/controllers/organization.controller.ts'), 'storage-service-active')
    await expectNoTodoMarkers(join(apiPath, 'src/modules/organizations/services/organization.service.ts'), 'storage-service-active')
    await expectFileContains(join(apiPath, 'src/modules/organizations/controllers/organization.controller.ts'), "import { FileInterceptor } from '@nestjs/platform-express'")
    await expectFileContains(
      join(apiPath, 'src/modules/organizations/services/organization.service.ts'),
      'private readonly accountAccessService: AccountAccessService,\n    private readonly storageService: StorageService'
    )
  })

  it('should set docker S3 credentials in .env when s3Setup is docker', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectEnvVar(join(apiPath, '.env'), 'S3_ENDPOINT', 'http://localhost:9000')
    await expectEnvVar(join(apiPath, '.env'), 'S3_ACCESS_KEY', 'minioadmin')
    await expectEnvVar(join(apiPath, '.env'), 'S3_SECRET_KEY', 'minioadmin')
    await expectEnvVar(join(apiPath, '.env'), 'S3_BUCKET', 'test-project-uploads')
  })

  it('should set custom S3 credentials in .env when s3Setup is credentials', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'credentials',
      s3Credentials: {
        endpoint: 'https://s3.amazonaws.com',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        bucket: 'my-bucket',
        region: 'eu-west-1'
      },
      skipNpmInstall: true
    })

    await expectEnvVar(join(apiPath, '.env'), 'S3_ENDPOINT', 'https://s3.amazonaws.com')
    await expectEnvVar(join(apiPath, '.env'), 'S3_ACCESS_KEY', 'AKIAIOSFODNN7EXAMPLE')
    await expectEnvVar(join(apiPath, '.env'), 'S3_BUCKET', 'my-bucket')
    await expectEnvVar(join(apiPath, '.env'), 'S3_REGION', 'eu-west-1')
  })

  it('should set test S3 credentials in .env.test', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectEnvVar(join(apiPath, '.env.test'), 'S3_ENDPOINT', 'http://localhost:9000')
    await expectEnvVar(join(apiPath, '.env.test'), 'S3_BUCKET', 'test-uploads')
  })

  it('should set VITE_STORAGE_ENABLED="true" in web .env', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    await expectFileContains(join(webPath, '.env'), 'VITE_STORAGE_ENABLED="true"')
  })

  it('should skip npm install when isMonorepo is true', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: true,
      projectName: 'test-project',
      s3Setup: 'docker'
    })

    // shelljs.exec should NOT have been called for npm install
    expect(shellSpy).not.toHaveBeenCalled()
  })

  it('should skip npm install when skipNpmInstall is true', async () => {
    await installStorageModule({
      apiPath,
      webPath,
      isMonorepo: false,
      projectName: 'test-project',
      s3Setup: 'docker',
      skipNpmInstall: true
    })

    expect(shellSpy).not.toHaveBeenCalled()
  })
})
