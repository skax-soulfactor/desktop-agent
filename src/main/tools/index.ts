import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { DesktopToolDef } from './defs'
import { fsRead, fsWrite, fsList } from './fs'
import { shellExec } from './shell'
import { shellExecElevated } from './elevated'
import { httpRequest } from './http'
import { checkPermission } from '../permissions/gateway'
import { isElevationEnabled } from '../permissions/elevation'
import { registerDocument } from '../agent/documents'
import type { FailureSignal } from '../memory/extract'

export const allToolDefs: DesktopToolDef[] = [
  fsRead,
  fsWrite,
  fsList,
  shellExec,
  shellExecElevated,
  httpRequest
]

export function toolDefByName(name: string): DesktopToolDef | undefined {
  return allToolDefs.find((d) => d.name === name)
}

/**
 * 앱 바깥의 사실을 실제로 관찰하는 도구인가 — 기억 추출의 "이번 턴에 확인한 것이 있는가" 판정 기준.
 *
 * 도구를 부르기만 하면 확인된 턴으로 치면, 방금 제가 만든 파일이나 제가 저장한 기억이 근거가 된다.
 * 실제로 그랬다: 에이전트가 OpenLiberty의 server.xml을 통째로 지어내 쓴 뒤 그 경로를 `출처:`로 달았고,
 * 도구가 done이라는 이유만으로 그 턴 전체가 확인된 턴으로 기록됐다.
 *
 * 바깥을 읽는 것(파일 읽기·목록, 셸, HTTP, MCP·검색)만 관찰로 친다.
 * 파일을 쓰는 도구와 앱 내부 상태를 다루는 제어 도구는 아니다. 피어의 답변도 아니다 —
 * 그쪽이 무엇을 근거로 답했는지 이쪽에서는 알 수 없다.
 */
const APP_CONTROL_TOOLS = new Set([
  'delegate_task',
  'cancel_task',
  'list_tasks',
  'save_memory',
  'schedule_task',
  'list_schedules',
  'cancel_schedule',
  'list_peers',
  'ask_peer',
  'delegate_to_peer',
  'list_secrets',
  'request_secret',
  'list_mcp_servers',
  'add_mcp_server'
])

export function observesWorld(toolName: string): boolean {
  const def = toolDefByName(toolName)
  // 이름을 모르는 것은 MCP 도구(mcp_<서버>_<도구>)와 web_search다 — 그쪽은 바깥을 읽는다
  if (!def) return !APP_CONTROL_TOOLS.has(toolName)
  return def.risk !== 'write'
}

export interface TurnContext {
  sessionId: string
  win: BrowserWindow
  failures: FailureSignal[]
  /**
   * 도구 결과 1건을 모델에 돌려줄 때의 문자 상한 (ModelProfile.toolResultChars).
   * shell_exec는 100KB, fs_read는 200KB까지 반환하는데, 컨텍스트가 4096토큰인
   * 로컬 모델에서는 결과 한 건이 대화 전체를 창 밖으로 밀어낸다.
   */
  resultChars?: number
  /**
   * 같은 조회가 반복돼 차단된 횟수. 되풀이만 하는 턴을 끊는 신호로 쓴다 —
   * 차단해도 모델이 같은 문단을 계속 내는 경우가 있어, 결국 사용자가 손으로 멈춰야 했다.
   */
  repeatedCalls?: number
  /**
   * 사람이 지켜보지 않는 경로(예약 실행·피어 위임)에서 도는 턴인가.
   * 참이면 상승 도구가 아예 노출되지 않고, 뚫고 들어와도 게이트웨이에서 거부된다.
   */
  unattended?: boolean
}

/**
 * 예산을 넘는 문자열은 자르지 않고 문서로 보관한 뒤 손잡이만 돌려준다.
 *
 * 잘라 버리면 뒷부분은 존재조차 알 수 없다. 문서로 두면 에이전트가 process_document로
 * 나눠서 처리할 수 있다 — 큰 파일을 fs_read로 읽거나 긴 셸 출력을 받은 경우에도
 * 첨부와 똑같이 다룰 수 있어야 한다.
 */
function offloadLargeText(
  value: unknown,
  maxChars: number,
  ctx: TurnContext,
  label: string
): unknown {
  if (typeof value === 'string' && value.length > maxChars) {
    const doc = registerDocument(ctx.sessionId, label, value)
    return {
      documentId: doc.id,
      tokens: doc.tokens,
      note:
        `결과가 커서 전문은 보관되었고 아래는 앞부분이다. 전체를 대상으로 하는 작업(번역·요약·분석·추출)은 ` +
        `preview로 답하지 말고 process_document(documentId="${doc.id}", ...)로 처리하라.`,
      preview: value.slice(0, Math.max(200, Math.floor(maxChars * 0.4)))
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = offloadLargeText(v, maxChars, ctx, `${label} — ${k}`)
    }
    return out
  }
  return value
}

/**
 * 도구 결과를 예산 안으로 줄인다. 통째로 자르면 JSON이 깨지므로,
 * 작은 필드는 그대로 두고 큰 문자열·배열 필드만 남은 예산을 나눠 갖는다.
 */
function capOutput(value: unknown, maxChars: number): unknown {
  const size = (v: unknown): number => (JSON.stringify(v) ?? '').length
  if (size(value) <= maxChars) return value

  if (typeof value === 'string') {
    return `${value.slice(0, maxChars)}\n...[${value.length - maxChars}자 잘림 — 필요하면 범위를 좁혀 다시 조회하라]`
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = []
    let used = 0
    for (const item of value) {
      const cost = size(item) + 1
      if (used + cost > maxChars) break
      used += cost
      kept.push(item)
    }
    if (kept.length < value.length) {
      // 첫 항목 하나가 예산보다 크면 위 루프는 아무것도 담지 못한다. 그대로 두면 도구를 부르고도
      // 결과를 한 글자도 못 보는 일이 생긴다 — 실제로 MCP 응답({content:[{text: 큰 문자열}]})이
      // 통째로 "1개 항목 생략"으로 바뀌어 사라졌다. 통째로 버리는 대신 잘라서라도 남긴다.
      if (kept.length === 0) kept.push(capOutput(value[0], maxChars))
      if (kept.length < value.length) kept.push(`...[${value.length - kept.length}개 항목 생략]`)
    }
    return kept
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const large = entries.filter(([, v]) => size(v) > 200)
    if (large.length === 0) return value
    const usedBySmall = entries
      .filter(([, v]) => size(v) <= 200)
      .reduce((n, [k, v]) => n + k.length + size(v) + 4, 0)
    const share = Math.max(200, Math.floor((maxChars - usedBySmall) / large.length))
    const out: Record<string, unknown> = {}
    for (const [k, v] of entries) out[k] = size(v) > 200 ? capOutput(v, share) : v
    return out
  }
  return value
}

/**
 * 도구 결과를 이번 턴의 예산에 맞춘다 — 큰 텍스트는 문서로 빼내고, 남는 부분만 줄인다.
 * buildTools 바깥에서 만들어지는 도구(MCP 검색 라우터 등)도 같은 규칙을 쓰도록 공개한다.
 */
export function capToolResult(result: unknown, ctx: TurnContext, label: string): unknown {
  if (!ctx.resultChars) return result
  return capOutput(offloadLargeText(result, ctx.resultChars, ctx, label), ctx.resultChars)
}

/**
 * 승인 다이얼로그에 함께 띄울 목적 설명. 모든 게이트 도구의 입력에 주입된다.
 * 사용자는 "무엇을 실행하는지"가 아니라 "왜 지금 필요한지"를 알아야 허용 여부를 판단할 수 있다.
 */
export const PURPOSE_DESCRIPTION =
  '이 실행이 왜 필요한지 사용자에게 보여줄 한 문장(사용자의 언어로). 반드시 채워라. 명령을 되풀이하지 말고 목적을 써라.'

export const PURPOSE_FIELD = z.string().optional().describe(PURPOSE_DESCRIPTION)

/** 게이트 도구 입력에 purpose를 덧붙인다 (원래 스키마는 건드리지 않는다) */
function withPurpose(schema: z.ZodTypeAny): z.ZodTypeAny {
  const obj = schema as z.ZodObject<z.ZodRawShape>
  if (typeof obj.extend !== 'function') return schema
  return obj.extend({ purpose: PURPOSE_FIELD })
}

/**
 * 모든 도구 실행을 Permission Gateway 통과 후로 강제하는 래퍼.
 * only를 주면 해당 이름의 도구만 노출 (메인 에이전트는 빠른 조회용, 워커는 전부).
 */
export function buildTools(ctx: TurnContext, only?: string[]): ToolSet {
  const tools: ToolSet = {}
  /**
   * 이번 턴에 이미 답이 나온 조회. 같은 조회를 되풀이하는 것을 막는다.
   *
   * 실제로 한 턴에서 같은 디렉토리 목록을 두 번 받고, 그 목록에 답이 있는데도
   * 없는 경로를 두 번 더 찾은 적이 있다. 조사 결과를 누적하라는 규칙은 프롬프트에
   * 있지만 작은 모델은 따르지 않는다. 되풀이 자체를 막고, 이미 했다는 사실을
   * 결과에 실어 돌려준다.
   *
   * 읽기 도구(fs_read·fs_list)만 담는다. 그리고 쓰기·실행 도구가 성공하면 통째로
   * 비운다 — 그 사이에 바깥이 바뀌었을 수 있어 이전 결과를 더는 믿을 수 없다.
   * (buildTools는 턴당 한 번 호출되므로 이 Map의 수명이 곧 턴이다)
   */
  const readCache = new Map<string, unknown>()
  const defs = allToolDefs
    .filter((d) => !only || only.includes(d.name))
    // 상승 도구는 기능이 켜져 있고 사람이 지켜보는 턴에서만 모델에게 보인다.
    // 정의가 아예 없으면 모델이 그 길을 떠올릴 수도 없다 (게이트웨이 차단은 그다음 방어선).
    .filter((d) => d.risk !== 'elevate' || (isElevationEnabled() && !ctx.unattended))
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: withPurpose(def.inputSchema),
      execute: async (raw: unknown) => {
        // purpose는 승인 화면 전용이므로 실제 도구 입력에서 분리한다
        const { purpose, ...rest } = (raw ?? {}) as Record<string, unknown>
        const input = rest
        const summary = def.describeCall(input)

        // 키 순서가 흔들려도 같은 호출로 보이도록 정렬한다 (도구 입력은 모두 평평한 객체다)
        const cacheKey = `${def.name} ${JSON.stringify(input, Object.keys(input).sort())}`
        if (def.risk === 'read' && readCache.has(cacheKey)) {
          ctx.repeatedCalls = (ctx.repeatedCalls ?? 0) + 1
          // 이미 승인받고 실행해 성공한 것과 완전히 같은 호출이므로 승인 창도 다시 띄우지 않는다
          return {
            repeated: true,
            note:
              '이번 턴에 이미 같은 조회를 했다. 아래는 그때 받은 결과다. ' +
              '같은 것을 또 부르지 말고, 이 결과를 근거로 다음 단계로 넘어가라.',
            result: readCache.get(cacheKey)
          }
        }
        // 승인 화면에 보여줄 값을 만드는 단계 — 여기서 실패하면 사용자를 부르기 전에 돌려보낸다
        let argv: string[] | undefined
        let target = ''
        try {
          argv = def.argvOf?.(input)
          target = def.targetOf(input)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          ctx.failures.push({ kind: 'tool-error', detail: `${summary} — ${msg}` })
          return { error: msg }
        }
        const gate = await checkPermission(ctx.win, {
          sessionId: ctx.sessionId,
          toolName: def.name,
          risk: def.risk,
          summary,
          target,
          suggestedPattern: def.suggestedPattern(input),
          inputJson: JSON.stringify(input, null, 2),
          purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : undefined,
          unattended: ctx.unattended,
          argv
        })
        if (!gate.allowed) {
          ctx.failures.push({ kind: 'approval-denied', detail: `${summary} — ${gate.reason}` })
          return { denied: true, reason: gate.reason }
        }
        try {
          const result = await def.execute(input)
          const capped = ctx.resultChars
            ? capOutput(offloadLargeText(result, ctx.resultChars, ctx, summary), ctx.resultChars)
            : result
          // 성공한 조회만 기억한다. 실패는 담지 않는다 — 그 사이에 파일이 생기면 답이 달라진다
          if (def.risk === 'read') readCache.set(cacheKey, capped)
          // 바깥 상태를 바꿨을 수 있는 도구가 돌았다면 앞선 조회 결과는 더는 사실이 아니다
          else readCache.clear()
          return capped
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          ctx.failures.push({ kind: 'tool-error', detail: `${summary} — ${msg}` })
          return { error: msg }
        }
      }
    })
  }
  return tools
}
