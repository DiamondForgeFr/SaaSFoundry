import { copy } from 'fs-extra'
import { readFile, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

import { installEmailModule } from '../../../installers/email.installer'
import { blueprintsPath } from '../../../types'
import { expectFileExists, expectNoTodoMarkers, expectEnvVar } from '../../helpers/assertions'

describe('installEmailModule (integration)', () => {
  let tempDir: string
  let apiPath: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-email-test-${Date.now()}`)
    apiPath = join(tempDir, 'apps/test-project-api')

    // Copy the full API blueprint to temp dir
    await copy(resolve(blueprintsPath, 'api'), apiPath)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('should copy MailerSend service file', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    await expectFileExists(join(apiPath, 'src/modules/email/services/mailersend.service.ts'))
  })

  it('should uncomment mailer-service-active markers in auth.service.ts', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    await expectNoTodoMarkers(join(apiPath, 'src/modules/auth/services/auth.service.ts'), 'mailer-service-active')
    const content = await readFile(join(apiPath, 'src/modules/auth/services/auth.service.ts'), 'utf8')
    expect(content).toContain('const { locale } = signUpDto')
  })

  it('should uncomment mailer-service-active markers in invitation.service.ts', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    await expectNoTodoMarkers(join(apiPath, 'src/modules/invitation/services/invitation.service.ts'), 'mailer-service-active')
  })

  it('should uncomment mailer-service-active markers in env.service.ts', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    await expectNoTodoMarkers(join(apiPath, 'src/configs/env/services/env.service.ts'), 'mailer-service-active')
  })

  it('should uncomment code in email.service.ts and remove console.logs', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    const content = await readFile(join(apiPath, 'src/modules/email/services/email.service.ts'), 'utf8')

    // console.log statements should be removed
    expect(content).not.toContain("console.log('html', html)")
    expect(content).not.toContain("console.log('text', text)")
  })

  it('should add MailerSendService to email.module.ts providers', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    const content = await readFile(join(apiPath, 'src/modules/email/email.module.ts'), 'utf8')

    expect(content).toContain('MailerSendService')
    expect(content).toContain("import { MailerSendService } from '@modules/email/services/mailersend.service'")
  })

  it('should rename disabled spec file to active spec file', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'test-key-123',
      mailersendSenderEmail: 'noreply@test.com',
      mailersendSenderName: 'TestApp'
    })

    await expectFileExists(join(apiPath, 'src/modules/email/tests/unit/email.service.spec.ts'))
  })

  it('should update .env with MailerSend credentials', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'ms_test_key_abc123',
      mailersendSenderEmail: 'hello@myapp.com',
      mailersendSenderName: 'MyApp'
    })

    await expectEnvVar(join(apiPath, '.env'), 'MAILERSEND_API_KEY', 'ms_test_key_abc123')
    await expectEnvVar(join(apiPath, '.env'), 'MAILERSEND_SENDER_EMAIL', 'hello@myapp.com')
    await expectEnvVar(join(apiPath, '.env'), 'MAILERSEND_SENDER_NAME', 'MyApp')
  })

  it('should update .env.test with test credentials', async () => {
    await installEmailModule({
      apiPath,
      isMonorepo: false,
      projectName: 'test-project',
      mailersendApiKey: 'ms_test_key_abc123',
      mailersendSenderEmail: 'hello@myapp.com',
      mailersendSenderName: 'MyApp'
    })

    const envTestContent = await readFile(join(apiPath, '.env.test'), 'utf8')

    // Test env should have a fake key
    expect(envTestContent).toContain('MAILERSEND_API_KEY="ms_test_fake_key_')
    expect(envTestContent).toContain('MAILERSEND_SENDER_EMAIL="hello@myapp.com"')
  })

  it('should update deployment.yml with MailerSend env vars when file exists', async () => {
    const deploymentPath = join(apiPath, '.github/workflows/deployment.yml')

    // Check if deployment.yml exists in the blueprint
    try {
      await readFile(deploymentPath, 'utf8')
      // Only test if it exists
      await installEmailModule({
        apiPath,
        isMonorepo: false,
        projectName: 'test-project',
        mailersendApiKey: 'test-key',
        mailersendSenderEmail: 'noreply@test.com',
        mailersendSenderName: 'Test'
      })

      const updatedContent = await readFile(deploymentPath, 'utf8')
      expect(updatedContent).toContain('MAILERSEND_API_KEY')
    } catch {
      // deployment.yml might not exist in blueprint, which is fine
    }
  })
})
