import { ApiProperty } from '@nestjs/swagger'

import type {
  AccountDeactivationScope,
  AccountSummary,
  CurrentScope,
  Entity,
  EntityAccountRef,
  LocaleValue,
  MeResponse,
  OrganizationRef,
  People,
  RoleAssignment,
  RoleScope,
  UserPreferences
} from '@shared-types/index'

export class AccountDto implements AccountSummary {
  @ApiProperty({
    description: 'Account unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string

  @ApiProperty({
    description: 'Account name',
    example: 'Main account'
  })
  name: string

  @ApiProperty({
    description: 'Account description',
    example: 'This is the main account for managing finances',
    required: false,
    nullable: true
  })
  description: string | null

  @ApiProperty({
    description: 'Account active status',
    example: true
  })
  isActive: boolean

  @ApiProperty({
    description: 'When inactive, indicates whether platform-admin or the account-owner disabled the account',
    enum: ['PLATFORM', 'ACCOUNT_OWNER'],
    nullable: true
  })
  deactivatedByScope: AccountDeactivationScope | null
}

export class OrganizationDto implements OrganizationRef {
  @ApiProperty({
    description: 'Organization unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string

  @ApiProperty({
    description: 'Organization name',
    example: 'ACME Corporation'
  })
  name: string
}

export class PeopleDto implements People {
  @ApiProperty({
    description: 'First name',
    example: 'John',
    nullable: true
  })
  firstname: string | null

  @ApiProperty({
    description: 'Last name',
    example: 'Doe',
    nullable: true
  })
  lastname: string | null
}

export class EntityAccountRefDto implements EntityAccountRef {
  @ApiProperty({
    description: 'Parent account unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string

  @ApiProperty({
    description: 'Parent account name',
    example: 'Main account'
  })
  name: string

  @ApiProperty({
    description: 'Parent account active status',
    example: true
  })
  isActive: boolean
}

export class EntityDto implements Entity {
  @ApiProperty({
    description: 'Entity unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  id: string

  @ApiProperty({
    description: 'Entity name',
    example: 'Finance Department'
  })
  name: string

  @ApiProperty({
    description: 'Entity active status',
    example: true
  })
  isActive: boolean

  @ApiProperty({
    description: 'Account ID this entity belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  accountId: string

  @ApiProperty({
    description: 'Organization information',
    type: OrganizationDto,
    nullable: true
  })
  organization: OrganizationDto | null

  @ApiProperty({
    description: 'Parent account summary (id, name, active state) — lets the UI surface the account a user is indirectly linked to through this entity',
    type: EntityAccountRefDto,
    nullable: true,
    required: false
  })
  account?: EntityAccountRefDto | null
}

export class UserPreferencesSummaryDto implements UserPreferences {
  @ApiProperty({
    description: 'User preferred locale (matches the Prisma Locale enum)',
    enum: ['EN', 'FR'],
    example: 'EN'
  })
  locale: LocaleValue

  @ApiProperty({
    description: 'Avatar URL pointing to the storage bucket; null when the user has no custom avatar',
    nullable: true,
    example: 'https://cdn.example.com/avatars/123.png'
  })
  avatarUrl: string | null
}

export class RoleAssignmentDto implements RoleAssignment {
  @ApiProperty({ description: 'Assignment unique identifier' })
  id: string

  @ApiProperty({ description: 'Role identifier' })
  roleId: number

  @ApiProperty({ description: 'Role name' })
  roleName: string

  @ApiProperty({ description: 'Role scope', enum: ['PLATFORM', 'ACCOUNT', 'ENTITY'] })
  scope: RoleScope

  @ApiProperty({ description: 'Account ID this assignment targets (only when scope = ACCOUNT)', nullable: true })
  accountId: string | null

  @ApiProperty({ description: 'Entity ID this assignment targets (only when scope = ENTITY)', nullable: true })
  entityId: string | null

  @ApiProperty({ description: 'Modules accessible through this assignment', type: String, isArray: true })
  modules: string[]

  @ApiProperty({ description: 'Sub-modules (visible sections) granted by this assignment', type: String, isArray: true })
  subModules: string[]

  @ApiProperty({ description: 'Permissions granted by this assignment', type: String, isArray: true })
  permissions: string[]
}

export class CurrentScopeDto implements CurrentScope {
  @ApiProperty({ enum: ['PLATFORM', 'ACCOUNT', 'ENTITY'] })
  kind: RoleScope

  @ApiProperty({ description: 'Target id (account/entity); null for PLATFORM', nullable: true })
  id: string | null
}

export class MeResponseDto implements MeResponse {
  @ApiProperty({
    description: 'User unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  userId: string

  @ApiProperty({
    description: 'User email address',
    example: 'john.doe@example.com'
  })
  email: string

  @ApiProperty({
    description: 'User personal information',
    type: PeopleDto
  })
  people: PeopleDto

  @ApiProperty({ description: 'Scoped role assignments', type: [RoleAssignmentDto] })
  roleAssignments: RoleAssignmentDto[]

  @ApiProperty({ description: 'Server-elected default scope (clients may switch)', type: CurrentScopeDto })
  currentScope: CurrentScopeDto

  @ApiProperty({
    description: 'Legacy flat union of role names',
    example: ['USER', 'ADMIN', 'TESTER'],
    type: String,
    isArray: true
  })
  roles: string[]

  @ApiProperty({
    description: 'Legacy flat union of module names',
    example: ['USER_ACCOUNT_PASSWORD_RECOVERY', 'USER_ACCOUNT_CREATION'],
    type: String,
    isArray: true
  })
  modules: string[]

  @ApiProperty({
    description: 'Legacy flat union of sub-module names',
    example: ['OVERVIEW', 'USERS', 'ROLES'],
    type: String,
    isArray: true
  })
  subModules: string[]

  @ApiProperty({
    description: 'Legacy flat union of permission names',
    example: ['USER_ACCOUNT_CREATE_OWN', 'PASSWORD_RECOVERY_LINK_REQUEST_OWN', 'PASSWORD_RECOVERY_RESET_OWN'],
    type: String,
    isArray: true
  })
  permissions: string[]

  @ApiProperty({
    description: 'User accounts',
    type: [AccountDto]
  })
  accounts: AccountDto[]

  @ApiProperty({
    description: 'User entities',
    type: [EntityDto]
  })
  entities: EntityDto[]

  @ApiProperty({
    description: 'User preferences (locale, avatar URL)',
    type: UserPreferencesSummaryDto
  })
  preferences: UserPreferencesSummaryDto

  @ApiProperty({
    description: 'Account creation date',
    example: '2024-03-06T12:00:00.000Z',
    type: Date
  })
  createdAt: Date
}
