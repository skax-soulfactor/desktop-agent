import { streamText, stepCountIs } from 'ai'
import { platform, homedir } from 'os'
import type { BrowserWindow } from 'electron'
import type { ChatEvent, ChatItem } from '@shared/types'
import { getActiveModel } from '../llm/providers'
import { buildTools, toolDefByName, type TurnContext } from '../tools'
import { buildMemoryContext } from '../memory/recall'
import { extractMemories } from '../memory/extract'
import { getSession, saveSession } from './sessions'

const MAX_STEPS = 25

const activeTurns = new Map<string, AbortController>()

export function abortTurn(sessionId: string): void {
  activeTurns.get(sessionId)?.abort()
}

function baseSystemPrompt(): string {
  return [
    '너는 사용자의 데스크톱에서 동작하는 협업 에이전트다. 도구(파일, 셸)를 사용해 사용자의 요청을 처리한다.',
    `실행 환경: ${platform()} / 홈 디렉토리: ${homedir()}`,
    '모든 도구 호출은 사용자의 승인을 거친다. 승인이 거부되면(denied) 이유를 존중하고 다른 방법을 제안하거나 사용자에게 물어라.',
    '파괴적이거나 되돌리기 어려운 작업은 실행 전에 무엇을 할지 설명하라.',
    '응답은 사용자의 언어로 한다.'
  ].join('\n')
}

export async function runTurn(win: BrowserWindow, sessionId: string, userText: string): Promise<void> {
  const send = (e: ChatEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('chat:event', { sessionId, ...e })
  }

  const session = getSession(sessionId)
  if (!session) {
    send({ type: 'turn-end', error: '세션을 찾을 수 없습니다.' })
    return
  }

  const abort = new AbortController()
  activeTurns.set(sessionId, abort)

  const ctx: TurnContext = { sessionId, win, failures: [] }
  const transcript: string[] = [`사용자: ${userText}`]

  session.items.push({ kind: 'user', text: userText })
  session.messages.push({ role: 'user', content: userText })
  if (session.meta.title === '새 대화') {
    session.meta.title = userText.slice(0, 40)
  }

  send({ type: 'turn-start' })

  try {
    const { model } = getActiveModel()
    const memoryContext = buildMemoryContext(userText)
    const system = memoryContext ? `${baseSystemPrompt()}\n\n${memoryContext}` : baseSystemPrompt()

    const result = streamText({
      model,
      system,
      messages: session.messages,
      tools: buildTools(ctx),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal
    })

    let assistantText = ''
    const toolItems = new Map<string, ChatItem & { kind: 'tool' }>()

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        const delta = part.text
        assistantText += delta
        send({ type: 'text-delta', text: delta })
      } else if (part.type === 'tool-call') {
        const def = toolDefByName(part.toolName)
        const summary = def ? def.describeCall(part.input as never) : part.toolName
        const item: ChatItem & { kind: 'tool' } = {
          kind: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          summary,
          status: 'running'
        }
        toolItems.set(part.toolCallId, item)
        transcript.push(`도구 호출: ${summary}`)
        send({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, summary })
      } else if (part.type === 'tool-result') {
        const output = JSON.stringify(part.output)
        const item = toolItems.get(part.toolCallId)
        const status: 'done' | 'denied' | 'error' = output.includes('"denied":true')
          ? 'denied'
          : output.includes('"error":')
            ? 'error'
            : 'done'
        if (item) {
          item.status = status
          item.output = output.slice(0, 2000)
        }
        transcript.push(`도구 결과(${status}): ${output.slice(0, 500)}`)
        send({ type: 'tool-result', toolCallId: part.toolCallId, status, output: output.slice(0, 2000) })
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }

    // 히스토리 반영
    const response = await result.response
    session.messages.push(...response.messages)
    // 표시용 아이템: 텍스트와 도구 카드를 순서대로 (간이 정렬 — 도구 먼저, 최종 텍스트 마지막)
    for (const item of toolItems.values()) session.items.push(item)
    if (assistantText) {
      session.items.push({ kind: 'assistant', text: assistantText })
      transcript.push(`에이전트: ${assistantText}`)
    }
    saveSession(session)
    send({ type: 'turn-end' })

    // 백그라운드 기억 추출 — 사용자 응답을 막지 않는다
    void extractMemories(sessionId, transcript.join('\n'), ctx.failures)
      .then((ops) => {
        if (ops.length > 0) {
          const fresh = getSession(sessionId)
          if (fresh) {
            fresh.items.push({ kind: 'memory', ops })
            saveSession(fresh)
          }
          send({ type: 'memory-saved', ops })
        }
      })
      .catch(() => {})
  } catch (e) {
    const aborted = abort.signal.aborted
    const msg = aborted ? '사용자가 중지했습니다.' : e instanceof Error ? e.message : String(e)
    saveSession(session)
    send({ type: 'turn-end', error: msg })
  } finally {
    activeTurns.delete(sessionId)
  }
}
