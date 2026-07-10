import { z } from 'zod'
import type { DesktopToolDef } from './defs'
import { resolveSecrets } from '../secrets/store'

const MAX_BODY = 100 * 1024
const TIMEOUT_MS = 60_000

function truncate(s: string): string {
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '\n...[본문 잘림]' : s
}

function originPattern(url: string): string {
  try {
    return new URL(url).origin + '/*'
  } catch {
    return url
  }
}

const schema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().describe('요청 URL (https 권장)'),
  headers: z
    .record(z.string())
    .optional()
    .describe('요청 헤더. 값에 {{secret:이름}} 플레이스홀더를 쓰면 실행 직전에 치환된다'),
  body: z.string().optional().describe('요청 본문 (JSON은 문자열로 직렬화해서 전달)')
})

/**
 * 외부 REST API 호출 도구 — Notion, Slack, GitHub 등 API 기반 연동의 기본 수단.
 * 시크릿은 플레이스홀더로만 참조하므로 토큰 원문이 LLM/대화 기록에 남지 않는다.
 */
export const httpRequest: DesktopToolDef<typeof schema> = {
  name: 'http_request',
  description:
    '외부 서비스의 HTTP API를 호출한다. 인증 토큰은 headers에 {{secret:이름}} 플레이스홀더로 넣으면 ' +
    '실행 시 안전하게 치환된다 (예: "Authorization": "Bearer {{secret:notion}}"). ' +
    '필요한 시크릿이 없으면 먼저 request_secret으로 사용자에게 등록을 요청하라.',
  risk: 'execute',
  inputSchema: schema,
  describeCall: (i) => `HTTP ${i.method} ${i.url}`,
  targetOf: (i) => i.url,
  suggestedPattern: (i) => originPattern(i.url),
  async execute(i) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(i.headers ?? {})) headers[k] = resolveSecrets(v)
    const url = resolveSecrets(i.url)
    const body = i.body !== undefined ? resolveSecrets(i.body) : undefined

    const res = await fetch(url, {
      method: i.method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = await res.text()
    return {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get('content-type') ?? '',
      body: truncate(text)
    }
  }
}
