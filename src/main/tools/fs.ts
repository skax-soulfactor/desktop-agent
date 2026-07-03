import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { DesktopToolDef } from './defs'

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p)
}

const MAX_READ = 200 * 1024

export const fsRead: DesktopToolDef<z.ZodObject<{ path: z.ZodString }>> = {
  name: 'fs_read',
  description: '텍스트 파일 내용을 읽는다. path는 절대 경로 또는 ~로 시작하는 경로.',
  risk: 'read',
  inputSchema: z.object({ path: z.string() }),
  describeCall: (i) => `파일 읽기: ${i.path}`,
  targetOf: (i) => expandHome(i.path),
  suggestedPattern: (i) => join(dirname(expandHome(i.path)), '**'),
  async execute(i) {
    const p = expandHome(i.path)
    const stat = statSync(p)
    if (stat.size > MAX_READ) {
      const content = readFileSync(p, 'utf-8').slice(0, MAX_READ)
      return { path: p, truncated: true, content }
    }
    return { path: p, truncated: false, content: readFileSync(p, 'utf-8') }
  }
}

export const fsWrite: DesktopToolDef<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>> = {
  name: 'fs_write',
  description: '텍스트 파일을 생성하거나 덮어쓴다. 필요한 상위 디렉토리는 자동 생성된다.',
  risk: 'write',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  describeCall: (i) => `파일 쓰기: ${i.path} (${i.content.length}자)`,
  targetOf: (i) => expandHome(i.path),
  suggestedPattern: (i) => join(dirname(expandHome(i.path)), '**'),
  async execute(i) {
    const p = expandHome(i.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, i.content, 'utf-8')
    return { path: p, written: i.content.length }
  }
}

export const fsList: DesktopToolDef<z.ZodObject<{ path: z.ZodString }>> = {
  name: 'fs_list',
  description: '디렉토리의 파일과 하위 디렉토리 목록을 반환한다.',
  risk: 'read',
  inputSchema: z.object({ path: z.string() }),
  describeCall: (i) => `디렉토리 목록: ${i.path}`,
  targetOf: (i) => expandHome(i.path),
  suggestedPattern: (i) => join(expandHome(i.path), '**'),
  async execute(i) {
    const p = expandHome(i.path)
    const entries = readdirSync(p, { withFileTypes: true }).slice(0, 500)
    return {
      path: p,
      entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
    }
  }
}
