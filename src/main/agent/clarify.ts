import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { ClarifyRequest } from '@shared/types'

interface Pending {
  resolve: (answer: string) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

export function respondClarify(requestId: string, answer: string): void {
  const p = pending.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(requestId)
  p.resolve(answer)
}

/** 대기 중인 질문 목록 (창 재오픈 시 복원용) */
export function pendingClarifications(): ClarifyRequest[] {
  return openRequests.slice()
}

const openRequests: ClarifyRequest[] = []
const TIMEOUT_MS = 30 * 60 * 1000

export interface ClarifyContext {
  win: BrowserWindow
  taskId: string
  taskTitle: string
  abortSignal: AbortSignal
  /** 대기 상태를 작업 칩에 반영 */
  onWaiting: (waiting: boolean) => void
}

/**
 * 워커가 작업 중 사용자 의견이 필요할 때 쓰는 도구.
 * 일반 도구이므로 AI SDK가 execute 완료를 기다려 워커가 자연히 멈추고,
 * 질문·답변이 워커 활동 로그에 카드로 남는다.
 */
export function clarifyTool(ctx: ClarifyContext): ToolSet {
  return {
    ask_user: tool({
      description:
        '작업을 계속하려면 사용자의 결정·의견·추가 정보가 필요할 때 사용한다. 사용자에게 질문하고 답을 받는다. ' +
        '되돌리기 어렵거나 취향이 갈리는 선택(파일 덮어쓰기 여부, 형식 선택 등)에서 임의로 정하지 말고 물어라. ' +
        'options를 주면 사용자가 선택지로 답할 수 있다.',
      inputSchema: z.object({
        question: z.string().describe('사용자에게 보여줄 질문'),
        options: z.array(z.string()).optional().describe('선택지 (선택). 자유 입력도 항상 허용된다')
      }),
      execute: async ({ question, options }) => {
        if (ctx.win.isDestroyed()) return { answer: '', note: '창이 닫혀 질문할 수 없습니다.' }
        const req: ClarifyRequest = {
          requestId: crypto.randomUUID(),
          taskId: ctx.taskId,
          taskTitle: ctx.taskTitle,
          question,
          options
        }
        ctx.onWaiting(true)
        try {
          const answer = await new Promise<string>((resolve) => {
            const finish = (val: string): void => {
              clearTimeout(timer)
              ctx.abortSignal.removeEventListener('abort', onAbort)
              pending.delete(req.requestId)
              const idx = openRequests.findIndex((r) => r.requestId === req.requestId)
              if (idx >= 0) openRequests.splice(idx, 1)
              resolve(val)
            }
            const onAbort = (): void => finish('[작업이 취소되었습니다]')
            const timer = setTimeout(() => finish('[사용자가 시간 내에 답하지 않았습니다]'), TIMEOUT_MS)
            pending.set(req.requestId, { resolve: finish, timer })
            openRequests.push(req)
            ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
            ctx.win.webContents.send('clarify:request', req)
          })
          return { answer }
        } finally {
          ctx.onWaiting(false)
        }
      }
    })
  }
}
