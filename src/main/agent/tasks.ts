import { streamText, stepCountIs, tool, type ToolSet } from 'ai'
import { platform, homedir } from 'os'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { TaskInfo, TaskStatus } from '@shared/types'
import { getActiveModel } from '../llm/providers'
import { describeError } from '../llm/errors'
import { buildTools, toolDefByName, type TurnContext } from '../tools'
import { buildMemoryContext } from '../memory/recall'
import { appendToSession } from './sessions'

const MAX_STEPS = 25

interface Task {
  info: TaskInfo
  abort: AbortController
}

const tasks = new Map<string, Task>()

function emit(win: BrowserWindow, info: TaskInfo): void {
  if (!win.isDestroyed()) {
    win.webContents.send('chat:event', { sessionId: info.sessionId, type: 'task-update', task: { ...info } })
  }
}

export function listTasks(sessionId?: string): TaskInfo[] {
  return [...tasks.values()]
    .map((t) => ({ ...t.info }))
    .filter((t) => !sessionId || t.sessionId === sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function cancelTask(taskId: string): boolean {
  const t = tasks.get(taskId)
  if (!t || t.info.status !== 'running') return false
  t.abort.abort()
  return true
}

/** 메인 에이전트가 작업을 위임하면 워커 서브 에이전트가 백그라운드에서 병렬 수행한다 */
export function startTask(
  win: BrowserWindow,
  sessionId: string,
  title: string,
  instruction: string
): TaskInfo {
  // 시작 전에 프로바이더 설정 오류를 조기에 드러낸다
  getActiveModel()

  const info: TaskInfo = {
    id: crypto.randomUUID(),
    sessionId,
    title,
    status: 'running',
    createdAt: new Date().toISOString()
  }
  tasks.set(info.id, { info, abort: new AbortController() })
  emit(win, info)
  void runTask(win, info.id, instruction)
  return { ...info }
}

function workerPrompt(): string {
  return [
    '너는 데스크톱 에이전트의 백그라운드 워커다. 메인 에이전트가 위임한 작업을 도구(파일, 셸)로 끝까지 수행한다.',
    `실행 환경: ${platform()} / 홈 디렉토리: ${homedir()}`,
    '사용자와 대화할 수 없다. 정보가 부족하면 합리적인 기본값을 선택하고 결과 보고에 그 선택을 명시하라.',
    '도구 승인이 거부되면 다른 방법을 시도하거나, 불가능하면 중단하고 이유를 보고하라.',
    '마지막 응답은 결과 보고여야 한다: 무엇을 했고, 무엇이 만들어졌으며, 미완이 있다면 무엇이 남았는지.'
  ].join('\n')
}

async function runTask(win: BrowserWindow, taskId: string, instruction: string): Promise<void> {
  const t = tasks.get(taskId)
  if (!t) return
  const { info, abort } = t
  const ctx: TurnContext = { sessionId: info.sessionId, win, failures: [] }

  try {
    const { model } = getActiveModel()
    const memoryContext = buildMemoryContext(instruction)
    const system = memoryContext ? `${workerPrompt()}\n\n${memoryContext}` : workerPrompt()

    const result = streamText({
      model,
      system,
      prompt: instruction,
      tools: buildTools(ctx),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal
    })

    let text = ''
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text
      } else if (part.type === 'tool-call') {
        const def = toolDefByName(part.toolName)
        info.detail = def ? def.describeCall(part.input as never) : part.toolName
        emit(win, info)
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }
    finishTask(win, info, 'done', text.trim() || '작업이 완료되었습니다.')
  } catch (e) {
    if (abort.signal.aborted) {
      finishTask(win, info, 'cancelled', '사용자 요청으로 취소되었습니다.')
    } else {
      finishTask(win, info, 'failed', describeError(e))
    }
  }
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '진행 중',
  done: '완료됨',
  failed: '실패함',
  cancelled: '취소됨'
}

function finishTask(win: BrowserWindow, info: TaskInfo, status: TaskStatus, result: string): void {
  info.status = status
  info.result = result.slice(0, 2000)
  info.detail = undefined
  info.finishedAt = new Date().toISOString()
  emit(win, info)

  // 결과 카드를 대화에 남기고, 메인 에이전트가 다음 턴에서 결과를 인지하도록 알림 메시지를 히스토리에 추가
  appendToSession(
    info.sessionId,
    [{ kind: 'task', taskId: info.id, title: info.title, status, result: info.result }],
    [
      {
        role: 'user',
        content:
          `[작업 알림 — 시스템 자동 메시지] 백그라운드 작업 "${info.title}" ${STATUS_LABEL[status]}. ` +
          `결과: ${info.result.slice(0, 800)}\n` +
          '(이 카드는 사용자 화면에 이미 표시되었다. 다음 응답에서 필요할 때만 자연스럽게 언급하라.)'
      }
    ]
  )
}

/** 메인(대화) 에이전트에게 노출되는 작업 관리 도구 — 데스크톱 자원이 아니므로 승인 게이트 미적용 */
export function taskTools(win: BrowserWindow, sessionId: string): ToolSet {
  return {
    delegate_task: tool({
      description:
        '파일 쓰기·셸 실행·여러 단계가 필요한 작업을 백그라운드 서브 에이전트에 위임한다. ' +
        '즉시 taskId를 반환하고 작업은 병렬로 진행되므로, 위임 후에는 사용자와 대화를 계속할 수 있다.',
      inputSchema: z.object({
        title: z.string().describe('작업 제목 한 줄 (사용자에게 표시됨)'),
        instruction: z.string().describe('서브 에이전트가 단독 수행할 수 있는 상세하고 자기완결적인 지시')
      }),
      execute: async ({ title, instruction }) => {
        try {
          const info = startTask(win, sessionId, title, instruction)
          return { taskId: info.id, status: info.status }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
    }),
    cancel_task: tool({
      description: '진행 중인 백그라운드 작업을 취소한다. 사용자가 작업 취소를 요청하면 사용하라.',
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const ok = cancelTask(taskId)
        return ok ? { cancelled: taskId } : { error: '해당 id의 진행 중 작업이 없습니다.' }
      }
    }),
    list_tasks: tool({
      description: '이 세션의 백그라운드 작업 목록과 상태(진행 중/완료/실패/취소)를 반환한다.',
      inputSchema: z.object({}),
      execute: async () => listTasks(sessionId)
    })
  }
}
