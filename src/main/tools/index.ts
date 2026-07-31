import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { DesktopToolDef } from './defs'
import { fsRead, fsWrite, fsList } from './fs'
import { shellExec } from './shell'
import { httpRequest } from './http'
import { checkPermission } from '../permissions/gateway'
import type { FailureSignal } from '../memory/extract'

export const allToolDefs: DesktopToolDef[] = [fsRead, fsWrite, fsList, shellExec, httpRequest]

export function toolDefByName(name: string): DesktopToolDef | undefined {
  return allToolDefs.find((d) => d.name === name)
}

export interface TurnContext {
  sessionId: string
  win: BrowserWindow
  failures: FailureSignal[]
}

/**
 * 승인 다이얼로그에 함께 띄울 목적 설명. 모든 게이트 도구의 입력에 주입된다.
 * 사용자는 "무엇을 실행하는지"가 아니라 "왜 지금 필요한지"를 알아야 허용 여부를 판단할 수 있다.
 */
export const PURPOSE_FIELD = z
  .string()
  .optional()
  .describe(
    '이 실행이 왜 필요한지 사용자에게 보여줄 한 문장(사용자의 언어로). 반드시 채워라. ' +
      '명령을 되풀이하지 말고 목적을 써라. ' +
      '예) "빌드 실패 원인을 좁히려고 최근 수정된 설정 파일의 변경 시각을 확인합니다."'
  )

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
          return await def.execute(input)
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
