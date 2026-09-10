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
        '정보(자료 저장 위치, 선호, 규칙, 요구사항)가 나오면 즉시 사용하라. 같은 제목이 있으면 갱신된다. ' +
        '검증되지 않은 진단·해결책은 사실로 저장하지 마라 — "원인은 X였다", "Y로 해결됐다"는 실제로 확인된 뒤에만 쓴다. ' +
        '조사가 끝나지 않았거나 원인을 못 찾고 끝났으면 제목과 본문에 무엇이 확정이고 무엇이 미검증인지, ' +
        '어떤 가설이 기각됐고 무엇이 남았는지 구분해 적어라. 다음 세션은 이 기억을 전제로 시작한다.',
      inputSchema: z.object({
        type: z.enum(['user', 'requirement', 'lesson', 'reference']),
        title: z.string().describe('한 줄 요약'),
        content: z.string().describe('본문 (마크다운)'),
        tags: z.array(z.string()).optional()
      }),
      execute: async ({ type, title, content, tags }) => {
        const existing = listMemories().find((m) => m.title === title)
        let op: MemoryOpSummary['op']
        let id: string
        if (existing) {
          updateMemory(existing.id, { type, content, ...(tags ? { tags } : {}) })
          op = 'update'
          id = existing.id
        } else {
          const created = createMemory({
            type,
            title,
            content,
            tags: tags ?? [],
            sourceSessionId: sessionId
          })
          op = 'create'
          id = created.id
        }
        const ops: MemoryOpSummary[] = [{ op, type, title, id }]
        appendToSession(sessionId, [{ kind: 'memory', ops }], [])
        if (!win.isDestroyed()) {
          win.webContents.send('chat:event', { sessionId, type: 'memory-saved', ops })
        }
        return { saved: title, op }
      }
    })
  }
}
