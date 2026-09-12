import { execFile } from 'node:child_process'
import { access, readFile, statfs } from 'node:fs/promises'
import { arch, cpus, freemem, platform, totalmem } from 'node:os'

import {
  createHostCapabilitySnapshot,
  type HostAcceleratorDevice,
  type HostArchitecture,
  type HostCapabilityEvidence,
  type HostCapabilityObservation,
  type HostCapabilitySnapshot,
  type HostOsFamily,
  type HostViabilityPolicy
} from './host-capabilities'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_TTL_MS = 60 * 60 * 1000
const COMMAND_TIMEOUT_MS = 2_000
const COMMAND_OUTPUT_BYTES = 256 * 1024
const FILE_OUTPUT_BYTES = 512 * 1024
const SAFE_FEATURE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export type HostProbeCommandId = 'darwin-physical-cpu' | 'darwin-cpu-features-arm64' | 'darwin-cpu-features-x64' | 'darwin-displays' | 'linux-nvidia-memory' | 'windows-hardware'

export interface HostProbeResult {
  state: 'ok' | 'unavailable' | 'failed' | 'timeout'
  stdout?: string
}

export interface HostProbeSystem {
  now(): Date
  platform(): string
  architecture(): string
  logicalCpuCount(): number
  totalMemoryBytes(): number
  availableMemoryBytes(): number
  availableStorageBytes(path: string): Promise<bigint>
  readTextFile(path: '/proc/cpuinfo'): Promise<HostProbeResult>
  runReadOnly(command: HostProbeCommandId): Promise<HostProbeResult>
}

export interface CollectHostCapabilitiesOptions {
  system?: HostProbeSystem
  workingDirectory?: string
  ttlMs?: number
  policy?: HostViabilityPolicy
}

interface CommandSpec {
  executable: string
  args: string[]
}

const COMMANDS: Record<HostProbeCommandId, CommandSpec> = {
  'darwin-physical-cpu': { executable: '/usr/sbin/sysctl', args: ['-n', 'hw.physicalcpu'] },
  'darwin-cpu-features-arm64': {
    executable: '/usr/sbin/sysctl',
    args: ['-n', 'hw.optional.arm64', 'hw.optional.arm.FEAT_AES', 'hw.optional.arm.FEAT_SHA256', 'hw.optional.arm.FEAT_SHA512', 'hw.optional.arm.FEAT_CRC32']
  },
  'darwin-cpu-features-x64': { executable: '/usr/sbin/sysctl', args: ['-n', 'machdep.cpu.features', 'machdep.cpu.leaf7_features'] },
  'darwin-displays': { executable: '/usr/sbin/system_profiler', args: ['SPDisplaysDataType', '-json'] },
  'linux-nvidia-memory': { executable: '/usr/bin/nvidia-smi', args: ['--query-gpu=memory.total', '--format=csv,noheader,nounits'] },
  'windows-hardware': {
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$cpu=Get-CimInstance Win32_Processor|Select-Object NumberOfCores; $gpu=Get-CimInstance Win32_VideoController|Select-Object AdapterRAM; @{cpu=$cpu;gpu=$gpu}|ConvertTo-Json -Compress -Depth 3'
    ]
  }
}

function executeReadOnly(spec: CommandSpec): Promise<HostProbeResult> {
  return new Promise((resolve) => {
    access(spec.executable)
      .then(() => {
        execFile(
          spec.executable,
          spec.args,
          {
            encoding: 'utf8',
            env: spec.executable.includes('WindowsPowerShell')
              ? { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }
              : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: COMMAND_OUTPUT_BYTES,
            windowsHide: true,
            shell: false
          },
          (error, stdout) => {
            if (!error) resolve({ state: 'ok', stdout: stdout.slice(0, COMMAND_OUTPUT_BYTES) })
            else if ('killed' in error && error.killed) resolve({ state: 'timeout' })
            else resolve({ state: 'failed' })
          }
        )
      })
      .catch(() => resolve({ state: 'unavailable' }))
  })
}

export const NODE_HOST_PROBE_SYSTEM: HostProbeSystem = {
  now: () => new Date(),
  platform,
  architecture: arch,
  logicalCpuCount: () => cpus().length,
  totalMemoryBytes: totalmem,
  availableMemoryBytes: freemem,
  availableStorageBytes: async (path) => {
    const stats = await statfs(path, { bigint: true })
    return stats.bavail * stats.bsize
  },
  readTextFile: async (path) => {
    try {
      const contents = await readFile(path, { encoding: 'utf8' })
      if (Buffer.byteLength(contents) > FILE_OUTPUT_BYTES) return { state: 'failed' }
      return { state: 'ok', stdout: contents }
    } catch (error) {
      return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'failed' }
    }
  },
  runReadOnly: (command) => {
    const spec = COMMANDS[command]
    return spec ? executeReadOnly(spec) : Promise.resolve({ state: 'failed' })
  }
}

function evidence<T>(state: HostCapabilityEvidence<T>['state'], value: T | null, sourceId: string, observedAt: string, reasonCode?: string): HostCapabilityEvidence<T> {
  return { state, value, sourceId, observedAt, ...(reasonCode ? { reasonCode } : {}) }
}

function observed<T>(value: T, sourceId: string, observedAt: string): HostCapabilityEvidence<T> {
  return evidence('observed', value, sourceId, observedAt)
}

function unknown<T>(sourceId: string, observedAt: string, reasonCode = 'metric-not-established'): HostCapabilityEvidence<T> {
  return evidence<T>('unknown', null, sourceId, observedAt, reasonCode)
}

function fromProbeFailure<T>(result: HostProbeResult, sourceId: string, observedAt: string): HostCapabilityEvidence<T> {
  const state = result.state === 'unavailable' ? 'unavailable' : 'failed'
  const reasonCode = result.state === 'timeout' ? 'probe-timeout' : result.state === 'unavailable' ? 'probe-unavailable' : 'probe-failed'
  return evidence<T>(state, null, sourceId, observedAt, reasonCode)
}

function osFamily(value: string): HostOsFamily {
  return value === 'darwin' ? 'macos' : value === 'linux' ? 'linux' : value === 'win32' ? 'windows' : 'unknown'
}

function architecture(value: string): HostArchitecture {
  return value === 'arm64' || value === 'x64' || value === 'riscv64' ? value : value === 'ia32' ? 'x86' : 'unknown'
}

function safeInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 && value <= 1024 ? value : null
}

function byteString(value: number | bigint): string | null {
  try {
    const bytes = typeof value === 'bigint' ? value : BigInt(Math.floor(value))
    return bytes >= 0n && bytes <= 2n ** 64n - 1n ? String(bytes) : null
  } catch {
    return null
  }
}

function cleanFeatures(values: string[]): string[] {
  return [...new Set(values.map((entry) => entry.toLowerCase()).filter((entry) => SAFE_FEATURE.test(entry)))].sort().slice(0, 128)
}

function parsePositiveInteger(output: string | undefined): number | null {
  const value = Number(output?.trim())
  return safeInteger(value)
}

function parseDarwinFeatures(output: string | undefined, hostArchitecture: HostArchitecture): string[] {
  if (!output) return []
  if (hostArchitecture === 'x64') return cleanFeatures(output.split(/\s+/))
  const names = ['arm64', 'aes', 'sha256', 'sha512', 'crc32']
  return cleanFeatures(
    output
      .trim()
      .split(/\s+/)
      .map((value, index) => (value === '1' ? names[index] : ''))
      .filter(Boolean)
  )
}

function parseLinuxCpuInfo(output: string | undefined): { physicalCores: number | null; features: string[] } {
  if (!output) return { physicalCores: null, features: [] }
  const processors = output.split(/\n\s*\n/).filter((block) => /^processor\s*:/m.test(block))
  const physicalPairs = new Set<string>()
  const features: string[] = []
  for (const block of processors) {
    const physical = block.match(/^physical id\s*:\s*(\d+)\s*$/m)?.[1]
    const core = block.match(/^core id\s*:\s*(\d+)\s*$/m)?.[1]
    if (physical !== undefined && core !== undefined) physicalPairs.add(`${physical}:${core}`)
    const featureLine = block.match(/^(?:flags|features)\s*:\s*(.+)$/im)?.[1]
    if (featureLine) features.push(...featureLine.split(/\s+/))
  }
  const physicalCores = physicalPairs.size > 0 ? safeInteger(physicalPairs.size) : null
  return { physicalCores, features: cleanFeatures(features) }
}

function parseNvidiaAccelerators(output: string | undefined): HostAcceleratorDevice[] {
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 16)
    .map((mib) => ({ backend: 'cuda', deviceClass: 'discrete', memoryKind: 'dedicated', memoryBytes: String(BigInt(Math.floor(mib)) * 1024n * 1024n) }))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseDarwinAccelerators(output: string | undefined, hostArchitecture: HostArchitecture, totalBytes: string | null): HostAcceleratorDevice[] | null {
  try {
    const parsed: unknown = JSON.parse(output ?? '')
    if (!record(parsed) || !Array.isArray(parsed.SPDisplaysDataType)) return null
    const devices: HostAcceleratorDevice[] = []
    for (const raw of parsed.SPDisplaysDataType.slice(0, 16)) {
      if (!record(raw)) continue
      const metal = Object.entries(raw).some(
        ([key, value]) => (key === 'spdisplays_mtlgpufamilysupport' || key.toLowerCase().includes('metal')) && typeof value === 'string' && !/unsupported|not[_\s-]*supported/i.test(value)
      )
      if (!metal) continue
      const vramText = Object.entries(raw).find(([key, value]) => key.toLowerCase().includes('vram') && typeof value === 'string')?.[1]
      const match = typeof vramText === 'string' ? vramText.match(/([0-9]+(?:\.[0-9]+)?)\s*(GB|MB)/i) : null
      const dedicatedBytes = match ? String(BigInt(Math.floor(Number(match[1]) * (match[2].toUpperCase() === 'GB' ? 1024 : 1))) * 1024n * 1024n) : null
      const unified = hostArchitecture === 'arm64'
      devices.push({
        backend: 'metal',
        deviceClass: unified ? 'integrated' : dedicatedBytes ? 'discrete' : 'unknown',
        memoryKind: unified ? 'unified' : dedicatedBytes ? 'dedicated' : 'unknown',
        memoryBytes: unified ? totalBytes : dedicatedBytes
      })
    }
    return devices.length > 0 ? devices : [{ backend: 'none', deviceClass: 'unknown', memoryKind: 'unknown', memoryBytes: null }]
  } catch {
    return null
  }
}

function parseWindowsHardware(output: string | undefined): { physicalCores: number | null; accelerators: HostAcceleratorDevice[] | null } {
  try {
    const parsed: unknown = JSON.parse(output ?? '')
    if (!record(parsed)) return { physicalCores: null, accelerators: null }
    const cpuEntries = Array.isArray(parsed.cpu) ? parsed.cpu : [parsed.cpu]
    const physicalCores = safeInteger(cpuEntries.reduce((sum, entry) => sum + (record(entry) && typeof entry.NumberOfCores === 'number' ? entry.NumberOfCores : 0), 0))
    const gpuEntries = Array.isArray(parsed.gpu) ? parsed.gpu : [parsed.gpu]
    const accelerators = gpuEntries
      .filter(record)
      .map((entry): HostAcceleratorDevice | null => {
        const memory = typeof entry.AdapterRAM === 'number' ? byteString(entry.AdapterRAM) : null
        return memory ? { backend: 'unknown', deviceClass: 'unknown', memoryKind: 'shared', memoryBytes: memory } : null
      })
      .filter((entry): entry is HostAcceleratorDevice => entry !== null)
    return { physicalCores, accelerators: accelerators.length > 0 ? accelerators.slice(0, 16) : null }
  } catch {
    return { physicalCores: null, accelerators: null }
  }
}

function numericEvidence(value: number, sourceId: string, observedAt: string): HostCapabilityEvidence<number> {
  const safe = safeInteger(value)
  return safe === null ? unknown(sourceId, observedAt, 'metric-invalid') : observed(safe, sourceId, observedAt)
}

function byteEvidence(value: number | bigint, sourceId: string, observedAt: string): HostCapabilityEvidence<string> {
  const safe = byteString(value)
  return safe === null ? unknown(sourceId, observedAt, 'metric-invalid') : observed(safe, sourceId, observedAt)
}

export async function collectHostInferenceCapabilities(options: CollectHostCapabilitiesOptions = {}): Promise<HostCapabilitySnapshot> {
  const system = options.system ?? NODE_HOST_PROBE_SYSTEM
  const now = system.now()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new RangeError(`ttlMs must be between 1 and ${MAX_TTL_MS}`)
  const observedAt = now.toISOString()
  const validUntil = new Date(now.getTime() + ttlMs).toISOString()
  const detectedOs = osFamily(system.platform())
  const detectedArchitecture = architecture(system.architecture())
  const totalMemory = byteString(system.totalMemoryBytes())
  const availableMemory = byteString(system.availableMemoryBytes())

  let storage: HostCapabilityEvidence<string>
  try {
    storage = byteEvidence(await system.availableStorageBytes(options.workingDirectory ?? process.cwd()), 'node/statfs/working-filesystem', observedAt)
  } catch {
    storage = evidence<string>('failed', null, 'node/statfs/working-filesystem', observedAt, 'probe-failed')
  }

  let physicalCores: HostCapabilityEvidence<number> = unknown('platform/physical-cpu', observedAt)
  let features: HostCapabilityEvidence<string[]> = unknown('platform/cpu-features', observedAt)
  let accelerators: HostCapabilityEvidence<HostAcceleratorDevice[]> = unknown('platform/accelerators', observedAt)

  if (detectedOs === 'macos') {
    const physical = await system.runReadOnly('darwin-physical-cpu')
    const featureProbe = await system.runReadOnly(detectedArchitecture === 'arm64' ? 'darwin-cpu-features-arm64' : 'darwin-cpu-features-x64')
    const displays = await system.runReadOnly('darwin-displays')
    const parsedPhysical = parsePositiveInteger(physical.stdout)
    physicalCores =
      physical.state === 'ok' && parsedPhysical !== null ? observed(parsedPhysical, 'darwin/sysctl/physicalcpu', observedAt) : fromProbeFailure(physical, 'darwin/sysctl/physicalcpu', observedAt)
    const parsedFeatures = parseDarwinFeatures(featureProbe.stdout, detectedArchitecture)
    features = featureProbe.state === 'ok' ? observed(parsedFeatures, 'darwin/sysctl/cpu-features', observedAt) : fromProbeFailure(featureProbe, 'darwin/sysctl/cpu-features', observedAt)
    const parsedAccelerators = parseDarwinAccelerators(displays.stdout, detectedArchitecture, totalMemory)
    accelerators =
      displays.state === 'ok' && parsedAccelerators
        ? observed(parsedAccelerators, 'darwin/system-profiler/displays', observedAt)
        : fromProbeFailure(displays, 'darwin/system-profiler/displays', observedAt)
  } else if (detectedOs === 'linux') {
    const cpuInfo = await system.readTextFile('/proc/cpuinfo')
    const parsedCpu = parseLinuxCpuInfo(cpuInfo.stdout)
    physicalCores =
      cpuInfo.state !== 'ok'
        ? fromProbeFailure(cpuInfo, 'linux/proc-cpuinfo/physical', observedAt)
        : parsedCpu.physicalCores !== null
          ? observed(parsedCpu.physicalCores, 'linux/proc-cpuinfo/physical', observedAt)
          : unknown('linux/proc-cpuinfo/physical', observedAt)
    features = cpuInfo.state === 'ok' ? observed(parsedCpu.features, 'linux/proc-cpuinfo/features', observedAt) : fromProbeFailure(cpuInfo, 'linux/proc-cpuinfo/features', observedAt)
    const nvidia = await system.runReadOnly('linux-nvidia-memory')
    const parsedAccelerators = parseNvidiaAccelerators(nvidia.stdout)
    accelerators =
      nvidia.state === 'ok' && parsedAccelerators.length > 0 ? observed(parsedAccelerators, 'linux/nvidia-smi/memory', observedAt) : fromProbeFailure(nvidia, 'linux/nvidia-smi/memory', observedAt)
  } else if (detectedOs === 'windows') {
    const hardware = await system.runReadOnly('windows-hardware')
    const parsed = parseWindowsHardware(hardware.stdout)
    physicalCores =
      hardware.state === 'ok' && parsed.physicalCores !== null
        ? observed(parsed.physicalCores, 'windows/cim/physicalcpu', observedAt)
        : fromProbeFailure(hardware, 'windows/cim/physicalcpu', observedAt)
    features = unknown('windows/cpu-features', observedAt)
    accelerators =
      hardware.state === 'ok' && parsed.accelerators ? observed(parsed.accelerators, 'windows/cim/video-memory', observedAt) : fromProbeFailure(hardware, 'windows/cim/video-memory', observedAt)
  }

  const safeAvailableMemory = totalMemory !== null && availableMemory !== null && BigInt(availableMemory) > BigInt(totalMemory) ? totalMemory : availableMemory
  const observation: HostCapabilityObservation = {
    schemaVersion: 1,
    observedAt,
    validUntil,
    platform: {
      os: observed(detectedOs, 'node/process-platform', observedAt),
      architecture: observed(detectedArchitecture, 'node/process-arch', observedAt)
    },
    cpu: {
      logicalCores: numericEvidence(system.logicalCpuCount(), 'node/os-cpus/logical', observedAt),
      physicalCores,
      features
    },
    accelerators,
    memory: {
      totalBytes: totalMemory === null ? unknown('node/os-totalmem', observedAt, 'metric-invalid') : observed(totalMemory, 'node/os-totalmem', observedAt),
      availableBytes: safeAvailableMemory === null ? unknown('node/os-freemem', observedAt, 'metric-invalid') : observed(safeAvailableMemory, 'node/os-freemem', observedAt)
    },
    storage: { availableBytes: storage }
  }
  return createHostCapabilitySnapshot(observation, options.policy)
}
