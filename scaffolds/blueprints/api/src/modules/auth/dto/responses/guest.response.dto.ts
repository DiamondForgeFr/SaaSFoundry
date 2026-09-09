import { ApiProperty } from '@nestjs/swagger'

import type { GuestResponse } from '@shared-types/index'

export class GuestResponseDto implements GuestResponse {
  @ApiProperty({
    description: 'User roles',
    example: ['GUEST'],
    type: String,
    isArray: true
  })
  roles: string[]

  @ApiProperty({
    description: 'Accessible modules for the guest user',
    example: ['USER_ACCOUNT_CREATION', 'USER_ACCOUNT_LOGIN'],
    type: String,
    isArray: true
  })
  modules: string[]

  @ApiProperty({
    description: 'Guest user permissions',
    example: ['USER_ACCOUNT_CREATE_OWN', 'USER_ACCOUNT_LOGIN'],
    type: String,
    isArray: true
  })
  permissions: string[]

  @ApiProperty({
    description: 'True while no platform-admin exists yet. Lets the front adapt the first-login UI (e.g. skip the account-name field). The actual role promotion stays server-side.',
    example: false
  })
  awaitsPlatformAdmin: boolean
}
