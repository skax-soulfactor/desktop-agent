import { streamText, stepCountIs } from 'ai'
import { platform, homedir } from 'os'
import type { BrowserWindow } from 'electron'
import type { AttachmentPayload, ChatEvent, ChatItem } from '@shared/types'
import { buildAttachmentParts } from './attachments'
import { getModelFor } from '../llm/providers'
import { describeError } from '../llm/errors'
import { buildTools, toolDefByName, type TurnContext } from '../tools'
import { buildMemoryContext } from '../memory/recall'
import { extractMemories } from '../memory/extract'
import { getSession, saveSession, appendToSession } from './sessions'
import { taskTools, listTasks } from './tasks'
import { scheduleTools } from './scheduler'
import { memoryTools } from '../memory/tools'
import { peerTools, buildPeerContext } from '../network/peerTools'
import { integrationTools } from '../integrations/tools'

const MAX_STEPS = 25

/** 메인(대화) 에이전트가 직접 쓸 수 있는 도구 — 빠른 읽기 전용. 나머지는 위임 */
const MAIN_AGENT_TOOLS = ['fs_read', 'fs_list']

const activeTurns = new Map<string, AbortController>()

export function abortTurn(sessionId: string): void {
  activeTurns.get(sessionId)?.abort()
}

/** 렌더러가 버튼 상태를 이벤트가 아닌 실제 실행 여부로 동기화할 수 있게 하는 진짜 출처 */
export function isTurnRunning(sessionId: string): boolean {
  return activeTurns.has(sessionId)
}

function baseSystemPrompt(sessionId: string): string {
  const lines = [
    '너는 사용자의 데스크톱에서 동작하는 협업 에이전트의 메인(대화) 에이전트다. 사용자와의 대화가 최우선이다.',
    `실행 환경: ${platform()} / 홈 디렉토리: ${homedir()}`,
    `현재 시각: ${new Date().toString()}`,
    '',
    '## 작업 위임 규칙',
    '- 너가 직접 쓸 수 있는 도구는 빠른 읽기 전용(fs_read, fs_list)뿐이다.',
    '- 파일 생성·수정, 셸 실행, 여러 단계가 필요하거나 오래 걸리는 작업은 반드시 delegate_task로 백그라운드 서브 에이전트에 위임하라.',
    '- 위임 지시(instruction)는 서브 에이전트가 단독으로 수행할 수 있게 자기완결적으로 작성하라.',
    '- 위임할 때 작업 난이도에 맞는 모델 등급(tier)을 지정하라: 단순 수집·정리·반복 작업은 "light", 일반 작업은 "standard", 복잡한 분석·코드 작성·중요 문서 작성은 "advanced". 사용자가 명시적으로 등급이나 품질을 요구하면 그것을 따르라.',
    '- 위임 직후 사용자에게 무엇을 시작했는지 짧게 알리고 턴을 끝내라. 작업 완료를 기다리지 마라.',
    '- 사용자가 작업 취소를 원하면 list_tasks로 확인 후 cancel_task를 호출하라.',
    '- 사용자가 "기억해줘"라고 명시하거나 앞으로 계속 쓰일 정보(자료 저장 위치, 선호, 규칙)가 나오면 save_memory로 즉시 저장하라.',
    '- 특정 시각 실행("오후 3시에") 또는 주기 실행("1시간마다", "매일 아침 9시") 요청은 schedule_task로 등록하라. 지금 즉시 1회 실행도 원하면 delegate_task를 함께 사용하라. 스케줄은 앱이 실행 중일 때만 동작함을 알려라.',
    '- "[작업 알림"으로 시작하는 메시지는 사용자가 아닌 시스템이 보낸 작업 상태 알림이다. 사용자 발언으로 취급하지 마라.',
    '- 메시지에 첨부(이미지, PDF, 문서 본문)가 포함되면 내용을 직접 읽고 처리하라(번역·요약·분석은 위임 없이 직접). 결과를 파일로 저장해야 하면 결과 본문을 instruction에 포함해 저장 작업만 위임하라. 워커는 첨부를 볼 수 없다.',
    '- 요청이 내 전문 밖이고 연결된 피어 에이전트가 적합하면 ask_peer(질의) 또는 delegate_to_peer(작업 위임)를 사용하라.',
    '',
    '## 외부 서비스 연동 규칙 (예: 노션, 슬랙, 옵시디안, 구글 등)',
    '- 사용자가 외부 서비스 연동·통합을 요청하면 바로 실행하지 말고, 먼저 가능한 연동 방식들을 조사해 나열하라.',
    '  일반적 선택지: ① 로컬 파일/앱 직접 조작 (예: 옵시디안 vault는 로컬 마크다운 폴더), ② 해당 앱의 플러그인 설치·설정,',
    '  ③ 공식 REST API 호출 (http_request + 시크릿), ④ MCP 서버 연동 (add_mcp_server).',
    '- 각 방식의 장단점(설정 난이도, 안정성, 유지보수)을 짧게 비교하고 상황에 맞는 최적안을 "추천"으로 명시한 뒤 사용자의 선택을 받아라.',
    '- 사용자가 방식을 고르면 단계별로 진행하라. 필요한 정보가 나올 때마다 사용자에게 물어라.',
    '- API 토큰 등 비밀값은 절대 채팅으로 받지 말고 request_secret으로 요청하라 (값은 너에게 노출되지 않고 키체인에 저장된다).',
    '  이미 있는지는 list_secrets로 확인하고, 저장된 시크릿은 http_request 헤더나 MCP 설정에 {{secret:이름}}으로 참조하라.',
    '- MCP 연동을 선택하면: 해당 서비스의 MCP 서버(공식 우선)를 확인하고, 필요한 시크릿을 확보한 뒤 add_mcp_server로 등록하라.',
    '  등록이 성공하면 반환된 도구 목록을 사용자에게 알려라. 등록된 MCP 도구는 위임된 워커가 사용한다.',
    '- 플러그인 설치·파일 작업·API 호출 등 실행 작업은 delegate_task로 위임하되, 연동 방식 결정과 시크릿 확보는 위임 전에 대화에서 끝내라.',
    '- 연동이 완료되면 확인 방법(간단한 테스트)을 제안하고, 연동 구성(방식·시크릿 이름·MCP 서버명)을 save_memory로 기억하라.',
    '',
    '모든 도구 호출은 사용자의 승인을 거친다. 거부되면 이유를 존중하고 다른 방법을 제안하라.',
    '응답은 사용자의 언어로 한다.'
  ]

  const peerCtx = buildPeerContext()
  if (peerCtx) lines.push('', peerCtx)

  const running = listTasks(sessionId).filter((t) => t.status === 'running')
  if (running.length > 0) {
    lines.push('', '## 현재 진행 중인 백그라운드 작업')
    for (const t of running) {
      lines.push(`- taskId=${t.id} "${t.title}"${t.detail ? ` (최근 활동: ${t.detail})` : ''}`)
    }
  }
  return lines.join('\n')
}

/** 게이트 도구는 정의에서, 작업 관리 도구는 이름별 규칙으로 요약 */
function summarizeCall(toolName: string, input: unknown): string {
  const def = toolDefByName(toolName)
  if (def) return def.describeCall(input as never)
  const i = (input ?? {}) as Record<string, unknown>
  if (toolName === 'delegate_task') return `작업 위임: ${String(i.title ?? '')}`
  if (toolName === 'cancel_task') return `작업 취소 요청: ${String(i.taskId ?? '')}`
  if (toolName === 'list_tasks') return '작업 목록 조회'
  if (toolName === 'save_memory') return `기억 저장: ${String(i.title ?? '')}`
  if (toolName === 'schedule_task') return `스케줄 등록: ${String(i.title ?? '')}`
  if (toolName === 'cancel_schedule') return `스케줄 삭제: ${String(i.scheduleId ?? '')}`
  if (toolName === 'list_schedules') return '스케줄 목록 조회'
  if (toolName === 'list_peers') return '피어 에이전트 목록 조회'
  if (toolName === 'ask_peer') return `피어에게 질의: ${String(i.question ?? '').slice(0, 40)}`
  if (toolName === 'delegate_to_peer') return `피어에게 작업 위임: ${String(i.title ?? '')}`
  if (toolName === 'list_secrets') return '시크릿 이름 목록 조회'
  if (toolName === 'request_secret') return `시크릿 입력 요청: ${String(i.name ?? '')}`
  if (toolName === 'list_mcp_servers') return 'MCP 서버 목록 조회'
  if (toolName === 'add_mcp_server') return `MCP 서버 등록: ${String(i.name ?? '')}`
  return toolName
}

export async function runTurn(
  win: BrowserWindow,
  sessionId: string,
  userText: string,
  attachments: AttachmentPayload[] = []
): Promise<void> {
  const send = (e: ChatEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('chat:event', { sessionId, ...e })
  }

  const session = getSession(sessionId)
  if (!session) {
    send({ type: 'turn-end', error: '세션을 찾을 수 없습니다.', unresolvedToolCallIds: [] })
    return
  }

  const abort = new AbortController()
  activeTurns.set(sessionId, abort)

  const ctx: TurnContext = { sessionId, win, failures: [] }
  const { parts, metas } = await buildAttachmentParts(attachments)
  const attachNote = metas.length > 0 ? ` [첨부: ${metas.map((m) => m.name).join(', ')}]` : ''
  const transcript: string[] = [`사용자: ${userText}${attachNote}`]

  // 사용자 메시지를 먼저 저장하고, 이후에는 append만 한다
  // (백그라운드 작업이 같은 세션에 동시 기록해도 서로 덮어쓰지 않도록)
  session.items.push({
    kind: 'user',
    text: userText,
    at: new Date().toISOString(),
    ...(metas.length > 0 ? { attachments: metas } : {})
  })
  session.messages.push({
    role: 'user',
    content: parts.length > 0 ? [...parts, { type: 'text', text: userText }] : userText
  })
  if (session.meta.title === '새 대화') {
    session.meta.title = userText.slice(0, 40)
  }
  saveSession(session)
  const messagesForModel = [...session.messages]

  send({ type: 'turn-start' })

  let assistantText = ''
  const toolItems = new Map<string, ChatItem & { kind: 'tool' }>()

  try {
    // 대화는 도구 호출 품질이 중요하므로 '일반' 등급 사용
    const { model } = getModelFor('standard')
    const memoryContext = buildMemoryContext(userText)
    const base = baseSystemPrompt(sessionId)
    const system = memoryContext ? `${base}\n\n${memoryContext}` : base

    const result = streamText({
      model,
      system,
      messages: messagesForModel,
      tools: {
        ...buildTools(ctx, MAIN_AGENT_TOOLS),
        ...taskTools(win, sessionId),
        ...scheduleTools(sessionId),
        ...memoryTools(win, sessionId),
        ...peerTools(),
        ...integrationTools(win, sessionId)
      },
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        const delta = part.text
        assistantText += delta
        send({ type: 'text-delta', text: delta })
      } else if (part.type === 'tool-call') {
        const summary = summarizeCall(part.toolName, part.input)
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

    // 히스토리 반영 — 디스크 최신 상태에 append (동시 기록 안전)
    const response = await result.response
    const newItems: ChatItem[] = [...toolItems.values()]
    if (assistantText) {
      newItems.push({ kind: 'assistant', text: assistantText, at: new Date().toISOString() })
      transcript.push(`에이전트: ${assistantText}`)
    }
    appendToSession(sessionId, newItems, response.messages)
    // 정상 종료 시에도 방어적으로 미해결 도구를 확정 (스텝 한도 등 대비)
    send({ type: 'turn-end', unresolvedToolCallIds: resolveDanglingTools(toolItems) })

    // 백그라운드 기억 추출 — 사용자 응답을 막지 않는다. 실패는 삼키지 않고 화면에 알린다
    void extractMemories(sessionId, transcript.join('\n'), ctx.failures)
      .then((ops) => {
        if (ops.length > 0) {
          appendToSession(sessionId, [{ kind: 'memory', ops }], [])
          send({ type: 'memory-saved', ops })
        }
      })
      .catch((e: unknown) => {
        const text = `기억 추출 실패: ${describeError(e)}`
        console.error('[memory]', text)
        appendToSession(sessionId, [{ kind: 'notice', text }], [])
        send({ type: 'notice', text })
      })
  } catch (e) {
    const aborted = abort.signal.aborted
    // 오류·중단으로 끝난 턴: 아직 '실행 중'인 도구 카드를 '중단됨'으로 확정한다
    const unresolved = resolveDanglingTools(toolItems)
    const newItems: ChatItem[] = [...toolItems.values()]
    if (assistantText) newItems.push({ kind: 'assistant', text: assistantText, at: new Date().toISOString() })
    appendToSession(sessionId, newItems, [])
    send({
      type: 'turn-end',
      error: aborted ? '사용자가 중지했습니다.' : describeError(e),
      unresolvedToolCallIds: unresolved
    })
  } finally {
    activeTurns.delete(sessionId)
  }
}

/** '실행 중'에 남은 도구를 '중단됨'으로 바꾸고 그 id 목록을 반환 */
function resolveDanglingTools(toolItems: Map<string, ChatItem & { kind: 'tool' }>): string[] {
  const ids: string[] = []
  for (const item of toolItems.values()) {
    if (item.status === 'running') {
      item.status = 'aborted'
      item.output = item.output ?? '턴이 종료되어 중단되었습니다.'
      ids.push(item.toolCallId)
    }
  }
  return ids
}
