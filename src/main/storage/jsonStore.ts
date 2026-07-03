import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'

let baseDir = ''

export function dataDir(): string {
  if (!baseDir) {
    baseDir = join(app.getPath('userData'), 'data')
    mkdirSync(baseDir, { recursive: true })
  }
  return baseDir
}

export function readJson<T>(file: string, fallback: T): T {
  const p = join(dataDir(), file)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  const p = join(dataDir(), file)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(value, null, 2), 'utf-8')
}

export function deleteFile(file: string): void {
  const p = join(dataDir(), file)
  if (existsSync(p)) rmSync(p)
}

export function listFiles(subdir: string): string[] {
  const p = join(dataDir(), subdir)
  if (!existsSync(p)) return []
  return readdirSync(p).filter((f) => f.endsWith('.json'))
}

export function appendLine(file: string, line: string): void {
  appendFileSync(join(dataDir(), file), line + '\n', 'utf-8')
}

export function readLines(file: string, lastN: number): string[] {
  const p = join(dataDir(), file)
  if (!existsSync(p)) return []
  const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean)
  return lines.slice(-lastN)
}
