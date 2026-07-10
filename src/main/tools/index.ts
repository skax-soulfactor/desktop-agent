import { tool, type ToolSet } from 'ai'
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
 * 모든 도구 실행을 Permission Gateway 통과 후로 강제하는 래퍼.
 * only를 주면 해당 이름의 도구만 노출 (메인 에이전트는 읽기 도구만, 워커는 전부).
 */
export function buildTools(ctx: TurnContext, only?: string[]): ToolSet {
  const tools: ToolSet = {}
  const defs = only ? allToolDefs.filter((d) => only.includes(d.name)) : allToolDefs
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: unknown) => {
        const summary = def.describeCall(input)
        const gate = await checkPermission(ctx.win, {
          sessionId: ctx.sessionId,
          toolName: def.name,
          risk: def.risk,
          summary,
          target: def.targetOf(input),
          suggestedPattern: def.suggestedPattern(input),
          inputJson: JSON.stringify(input, null, 2)
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
