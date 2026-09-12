import { collectHostInferenceCapabilities, type HostProbeCommandId, type HostProbeResult, type HostProbeSystem } from '../../../execution'

const NOW = new Date('2026-09-12T12:00:00.000Z')
const GIB = 1024 ** 3

function system(
  overrides: Partial<HostProbeSystem> & {
    commands?: Partial<Record<HostProbeCommandId, HostProbeResult>>
  } = {}
): HostProbeSystem {
  const commands = overrides.commands ?? {}
  return {
    now: () => NOW,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    logicalCpuCount: () => 10,
    totalMemoryBytes: () => 64 * GIB,
    availableMemoryBytes: () => 16 * GIB,
    availableStorageBytes: async () => BigInt(64 * GIB),
    readTextFile: async () => ({ state: 'unavailable' }),
    runReadOnly: async (command) => commands[command] ?? ({ state: 'failed' } as HostProbeResult),
    ...overrides
  }
}

describe('read-only host capability probes (#740)', () => {
  it('collects a bounded macOS snapshot and treats Apple accelerator memory as unified', async () => {
    const commands: Partial<Record<HostProbeCommandId, HostProbeResult>> = {
      'darwin-physical-cpu': { state: 'ok', stdout: '8\n' },
      'darwin-cpu-features-arm64': { state: 'ok', stdout: '1\n1\n1\n1\n1\n' },
      'darwin-displays': { state: 'ok', stdout: JSON.stringify({ SPDisplaysDataType: [{ spdisplays_mtlgpufamilysupport: 'spdisplays_metal4' }] }) }
    }

    const snapshot = await collectHostInferenceCapabilities({ system: system({ commands }), workingDirectory: '/safe/project' })

    expect(snapshot.observedAt).toBe('2026-09-12T12:00:00.000Z')
    expect(snapshot.validUntil).toBe('2026-09-12T12:05:00.000Z')
    expect(snapshot.platform.os.value).toBe('macos')
    expect(snapshot.cpu).toMatchObject({ logicalCores: { value: 10 }, physicalCores: { value: 8 } })
    expect(snapshot.cpu.features.value).toEqual(['aes', 'arm64', 'crc32', 'sha256', 'sha512'])
    expect(snapshot.accelerators.value).toEqual([{ backend: 'metal', deviceClass: 'integrated', memoryKind: 'unified', memoryBytes: String(64 * GIB) }])
    expect(snapshot.viability.tier).toBe('high-capability')
  })

  it('parses Linux CPU evidence and fixed nvidia memory output without device identifiers', async () => {
    const cpuInfo = ['processor : 0\nphysical id : 0\ncore id : 0\nflags : sse4_2 avx2 aes', 'processor : 1\nphysical id : 0\ncore id : 1\nflags : sse4_2 avx2 aes'].join('\n\n')
    const host = system({
      platform: () => 'linux',
      architecture: () => 'x64',
      logicalCpuCount: () => 8,
      totalMemoryBytes: () => 32 * GIB,
      availableMemoryBytes: () => 8 * GIB,
      availableStorageBytes: async () => BigInt(32 * GIB),
      readTextFile: async () => ({ state: 'ok', stdout: cpuInfo }),
      commands: { 'linux-nvidia-memory': { state: 'ok', stdout: '24576\n' } }
    })

    const snapshot = await collectHostInferenceCapabilities({ system: host })

    expect(snapshot.cpu.physicalCores.value).toBe(2)
    expect(snapshot.cpu.features.value).toEqual(['aes', 'avx2', 'sse4_2'])
    expect(snapshot.accelerators.value).toEqual([{ backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: String(24 * GIB) }])
    expect(snapshot.viability.tier).toBe('coding-capable')
    expect(JSON.stringify(snapshot)).not.toContain('physical id')
  })

  it('preserves failed and unavailable probes as explicit safe evidence', async () => {
    const attempted: HostProbeCommandId[] = []
    const host = system({
      platform: () => 'linux',
      readTextFile: async () => ({ state: 'failed', stdout: 'authorization=Bearer secret-value' }),
      runReadOnly: async (command) => {
        attempted.push(command)
        return { state: 'unavailable', stdout: 'github_pat_secret-value' }
      },
      availableStorageBytes: async () => {
        throw new Error('/private/user/path')
      }
    })

    const snapshot = await collectHostInferenceCapabilities({ system: host })
    const serialized = JSON.stringify(snapshot)

    expect(attempted).toEqual(['linux-nvidia-memory'])
    expect(snapshot.cpu.features).toMatchObject({ state: 'failed', value: null, reasonCode: 'probe-failed' })
    expect(snapshot.accelerators).toMatchObject({ state: 'unavailable', value: null, reasonCode: 'probe-unavailable' })
    expect(snapshot.storage.availableBytes).toMatchObject({ state: 'failed', value: null, reasonCode: 'probe-failed' })
    expect(snapshot.viability.tier).toBe('unsupported')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('/private/user/path')
  })

  it('uses one fixed Windows probe and reports facts it cannot establish as unknown', async () => {
    const attempted: HostProbeCommandId[] = []
    const host = system({
      platform: () => 'win32',
      architecture: () => 'x64',
      runReadOnly: async (command) => {
        attempted.push(command)
        return { state: 'ok', stdout: JSON.stringify({ cpu: [{ NumberOfCores: 8 }], gpu: [{ AdapterRAM: 8 * GIB }] }) }
      }
    })

    const snapshot = await collectHostInferenceCapabilities({ system: host })

    expect(attempted).toEqual(['windows-hardware'])
    expect(snapshot.cpu.physicalCores.value).toBe(8)
    expect(snapshot.cpu.features).toMatchObject({ state: 'unknown', value: null })
    expect(snapshot.accelerators.value).toEqual([{ backend: 'unknown', deviceClass: 'unknown', memoryKind: 'shared', memoryBytes: String(8 * GIB) }])
  })

  it('does not run platform commands on an unknown OS and validates freshness bounds', async () => {
    const runReadOnly = jest.fn(async () => ({ state: 'failed' as const }))
    const host = system({ platform: () => 'freebsd', architecture: () => 'sparc', runReadOnly })

    const snapshot = await collectHostInferenceCapabilities({ system: host })

    expect(runReadOnly).not.toHaveBeenCalled()
    expect(snapshot.platform).toMatchObject({ os: { value: 'unknown' }, architecture: { value: 'unknown' } })
    expect(snapshot.viability.constraintCodes).toEqual(expect.arrayContaining(['platform-unknown', 'architecture-unknown']))
    await expect(collectHostInferenceCapabilities({ system: host, ttlMs: 0 })).rejects.toThrow(/ttlMs/)
    await expect(collectHostInferenceCapabilities({ system: host, ttlMs: 3_600_001 })).rejects.toThrow(/ttlMs/)
  })
})
