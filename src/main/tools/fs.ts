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
  // 설정 파일 작성 지침이 도구 설명에 붙어 있는 이유: 같은 내용을 시스템 프롬프트에 넣었을 때
  // 로컬 9B는 따르지 않았다(3회 실측). 작은 모델은 호출 직전에 도구 설명을 읽으므로 여기가 더 잘 걸린다.
  description:
    '텍스트 파일을 생성하거나 덮어쓴다. 필요한 상위 디렉토리는 자동 생성된다. ' +
    '설정 파일이라면 먼저 그 제품이 설치 폴더에 갖고 있는 템플릿·샘플(templates/, samples/, *.sample, *.example)을 ' +
    'fs_read로 읽고 그것을 고쳐 써라. 전용 생성 명령(bin 아래 create·init 등)이 있으면 그쪽을 먼저 쓴다. ' +
    '엘리먼트·속성 이름과 파일이 놓일 경로를 기억으로 지어내지 마라 — 제품과 버전마다 다르다.',
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
