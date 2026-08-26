import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { DesktopToolDef } from './defs'
import { fsRead, fsWrite, fsList } from './fs'
import { shellExec } from './shell'
import { httpRequest } from './http'
import { checkPermission } from '../permissions/gateway'
import { registerDocument } from '../agent/documents'
import type { FailureSignal } from '../memory/extract'

export const allToolDefs: DesktopToolDef[] = [fsRead, fsWrite, fsList, shellExec, httpRequest]

export function toolDefByName(name: string): DesktopToolDef | undefined {
  return allToolDefs.find((d) => d.name === name)
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
    if (kept.length < value.length) kept.push(`...[${value.length - kept.length}개 항목 생략]`)
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
  const defs = only ? allToolDefs.filter((d) => only.includes(d.name)) : allToolDefs
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: withPurpose(def.inputSchema),
      execute: async (raw: unknown) => {
        // purpose는 승인 화면 전용이므로 실제 도구 입력에서 분리한다
        const { purpose, ...rest } = (raw ?? {}) as Record<string, unknown>
        const input = rest
        const summary = def.describeCall(input)
        const gate = await checkPermission(ctx.win, {
          sessionId: ctx.sessionId,
          toolName: def.name,
          risk: def.risk,
          summary,
          target: def.targetOf(input),
          suggestedPattern: def.suggestedPattern(input),
          inputJson: JSON.stringify(input, null, 2),
          purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : undefined
        })
        if (!gate.allowed) {
          ctx.failures.push({ kind: 'approval-denied', detail: `${summary} — ${gate.reason}` })
          return { denied: true, reason: gate.reason }
        }
        try {
          const result = await def.execute(input)
          if (!ctx.resultChars) return result
          // 먼저 큰 텍스트를 문서로 빼내고, 그래도 남는 부분만 줄인다
          return capOutput(offloadLargeText(result, ctx.resultChars, ctx, summary), ctx.resultChars)
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
