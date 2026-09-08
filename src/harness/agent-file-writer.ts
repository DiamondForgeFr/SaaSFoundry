import { constants } from 'fs'
import { lstat, mkdir, open } from 'fs/promises'
import { join, resolve } from 'path'

/**
 * Open without truncating or following a destination link. Recheck directory
 * identities and the opened inode before writing any bytes through the handle.
 * Cooperating writers additionally hold the checkout's agent setup lock.
 */
export async function safeWriteAgentFile(rootPath: string, path: string, content: Buffer, mode: number, expected?: Buffer): Promise<void> {
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe agent file path: ${path}`)
  const root = resolve(rootPath)
  const parents: { path: string; dev: number; ino: number }[] = []
  let current = root
  for (const part of ['', ...path.split('/').slice(0, -1)]) {
    if (part) current = join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe agent file parent: ${path}`)
    parents.push({ path: current, dev: stat.dev, ino: stat.ino })
  }
  const destination = join(root, path)
  const before = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (expected === undefined && before) throw Object.assign(new Error(`Agent target already exists: ${path}`), { code: 'EEXIST' })
  if (expected !== undefined && (!before?.isFile() || before.isSymbolicLink() || before.nlink > 1)) throw new Error(`Agent target changed or is not an exclusive regular file: ${path}`)
  const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (expected === undefined ? constants.O_CREAT | constants.O_EXCL : 0)
  const file = await open(destination, flags, mode)
  try {
    const opened = await file.stat()
    const now = await lstat(destination)
    if (!now.isFile() || now.isSymbolicLink() || now.nlink > 1 || opened.dev !== now.dev || opened.ino !== now.ino || (before && (opened.dev !== before.dev || opened.ino !== before.ino))) {
      throw new Error(`Agent target changed while opening: ${path}`)
    }
    for (const parent of parents) {
      const stat = await lstat(parent.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parent.dev || stat.ino !== parent.ino) throw new Error(`Agent parent changed while opening: ${path}`)
    }
    if (expected !== undefined && !(await file.readFile()).equals(expected)) throw new Error(`Agent target changed before writing: ${path}`)
    let offset = 0
    while (offset < content.length) {
      const { bytesWritten } = await file.write(content, offset, content.length - offset, offset)
      if (!bytesWritten) throw new Error(`Agent file write stopped: ${path}`)
      offset += bytesWritten
    }
    await file.truncate(content.length)
  } finally {
    await file.close()
  }
}
