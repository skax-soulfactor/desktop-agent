import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { MemoryOpSummary } from '@shared/types'
import { createMemory, listMemories, updateMemory } from './store'
import { appendToSession } from '../agent/sessions'

/**
 * 메인 에이전트용 기억 저장 도구.
 * 사용자가 명시적으로 기억을 요청하면 백그라운드 추출에 의존하지 않고 즉시·확정적으로 저장한다.
 */
export function memoryTools(win: BrowserWindow, sessionId: string): ToolSet {
  return {
    save_memory: tool({
      description:
        '지식베이스에 기억을 저장한다. 사용자가 "기억해줘"라고 명시하거나, 앞으로의 협업에 계속 쓰일 ' +
        '정보(자료 저장 위치, 선호, 규칙, 요구사항)가 나오면 즉시 사용하라. 같은 제목이 있으면 갱신된다.',
      inputSchema: z.object({
        type: z.enum(['user', 'requirement', 'lesson', 'reference']),
        title: z.string().describe('한 줄 요약'),
        content: z.string().describe('본문 (마크다운)'),
        tags: z.array(z.string()).optional()
      }),
      execute: async ({ type, title, content, tags }) => {
        const existing = listMemories().find((m) => m.title === title)
        let op: MemoryOpSummary['op']
        if (existing) {
          updateMemory(existing.id, { type, content, ...(tags ? { tags } : {}) })
          op = 'update'
        } else {
          createMemory({ type, title, content, tags: tags ?? [], sourceSessionId: sessionId })
          op = 'create'
        }
        const ops: MemoryOpSummary[] = [{ op, type, title }]
        appendToSession(sessionId, [{ kind: 'memory', ops }], [])
        if (!win.isDestroyed()) {
          win.webContents.send('chat:event', { sessionId, type: 'memory-saved', ops })
        }
        return { saved: title, op }
      }
    })
  }
}
