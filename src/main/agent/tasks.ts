import { streamText, stepCountIs, tool, type ToolSet } from 'ai'
import { platform, homedir } from 'os'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { ChatItem, ModelTier, TaskInfo, TaskStatus } from '@shared/types'
import { getModelFor, resolveModelFor } from '../llm/providers'
import { estimateTokens } from '../llm/profile'
import { describeError } from '../llm/errors'
import { buildTools, toolDefByName, type TurnContext } from '../tools'
import { buildMemoryContext } from '../memory/recall'
import { appendToSession, addSessionUsage } from './sessions'
import { recordUsage } from '../usage/store'
import { notifyIfBackground } from '../notify'
import { clarifyTool } from './clarify'
import { integrationTools } from '../integrations/tools'
import { mcpToolsFor } from '../mcp/manager'
import { getDocument, runDocumentJob, type DocumentPlan } from './documents'
import { recordRun } from '../skills/store'

interface Task {
  info: TaskInfo
  abort: AbortController
}

const tasks = new Map<string, Task>()

/** 로그는 이후에도 계속 변형되므로 이벤트/조회 시 스냅샷을 복사해 보낸다 */
function snapshot(info: TaskInfo): TaskInfo {
  return { ...info, log: info.log?.map((x) => ({ ...x })) }
}

function emit(win: BrowserWindow, info: TaskInfo): void {
  if (!win.isDestroyed()) {
    win.webContents.send('chat:event', { sessionId: info.sessionId, type: 'task-update', task: snapshot(info) })
  }
}

export function listTasks(sessionId?: string): TaskInfo[] {
  return [...tasks.values()]
    .map((t) => snapshot(t.info))
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
  instruction: string,
  tier: ModelTier = 'standard',
  /** 사람이 지켜보지 않는 경로(예약 실행·피어 위임)에서 시작한 작업이면 참 — 권한 상승이 금지된다 */
  unattended = false
): TaskInfo {
  // 시작 전에 프로바이더 설정 오류를 조기에 드러낸다
  getModelFor(tier)

  const info: TaskInfo = {
    id: crypto.randomUUID(),
    sessionId,
    title,
    status: 'running',
    tier,
    createdAt: new Date().toISOString(),
    unattended
  }
  tasks.set(info.id, { info, abort: new AbortController() })
  emit(win, info)
  void runTask(win, info.id, instruction)
  return { ...info }
}

/**
 * 창보다 큰 문서를 조각으로 나눠 처리하는 작업. 워커(에이전트 루프)와 달리 도구를 쓰지 않는
 * 결정적 파이프라인이라, 진행 상황이 "몇 번째 조각"으로 정확히 드러난다.
 */
export function startDocumentTask(
  win: BrowserWindow,
  sessionId: string,
  documentId: string,
  instruction: string,
  mode: 'transform' | 'reduce',
  /** 사용자가 확인 대화에서 동의한 계획 — 보여준 조각 그대로 실행한다 */
  plan?: DocumentPlan
): TaskInfo {
  const doc = getDocument(documentId)
  if (!doc) throw new Error(`documentId ${documentId}에 해당하는 문서가 없습니다.`)

  const info: TaskInfo = {
    id: crypto.randomUUID(),
    sessionId,
    title: `${doc.name} — ${instruction.slice(0, 40)}`,
    status: 'running',
    tier: 'standard',
    createdAt: new Date().toISOString()
  }
  const abort = new AbortController()
  tasks.set(info.id, { info, abort })

  // 워커와 마찬가지로 활동 로그를 남긴다 — 이게 없으면 실행 중 작업의 "보기"가 빈 화면이 된다
  const log: ChatItem[] = []
  info.log = log
  const steps = new Map<string, ChatItem & { kind: 'tool' }>()
  emit(win, info)

  void (async () => {
    try {
      const result = await runDocumentJob(sessionId, doc, instruction, mode, {
        signal: abort.signal,
        onProgress: (done, total) => {
          info.detail = `${done}/${total} 조각 처리`
          emit(win, info)
        },
        onStepStart: (id, summary) => {
          const item: ChatItem & { kind: 'tool' } = {
            kind: 'tool',
            toolCallId: id,
            toolName: 'process_document',
            summary,
            status: 'running'
          }
          steps.set(id, item)
          if (log.length < MAX_LOG_ITEMS) log.push(item)
          emit(win, info)
        },
        onStepEnd: (id: string, status: 'done' | 'error', output: string) => {
          const item = steps.get(id)
          if (item) {
            item.status = status
            item.output = output
          }
          emit(win, info)
        }
      }, plan)
      info.usage = { input: result.inputTokens, output: result.outputTokens }
      addSessionUsage(sessionId, result.inputTokens, result.outputTokens)

      // 같은 작업이 반복되면 스킬로 굳힌다. 판단 근거는 모델의 추측이 아니라 실제 사용 이력이다.
      // 대부분 조각이 처리되지 않은 실행은 본보기로 삼을 수 없으므로 제외한다.
      const mostlyProcessed = result.unchanged <= Math.floor(result.chunks / 2)
      const promoted = mostlyProcessed ? recordRun(instruction, mode) : null
      if (promoted?.created) {
        const text =
          `반복해서 쓰신 작업이라 스킬 "${promoted.skill.name}"로 저장했습니다. ` +
          '스킬 탭에서 지시문을 직접 다듬거나 삭제할 수 있습니다.'
        appendToSession(sessionId, [{ kind: 'notice', text }], [])
        if (!win.isDestroyed()) win.webContents.send('chat:event', { sessionId, type: 'notice', text })
      }

      finishTask(
        win,
        info,
        'done',
        result.text,
        `"${doc.name}"을(를) ${result.chunks}개 조각으로 나눠 처리하고 결과를 하나로 합쳤다 ` +
          `(결과 약 ${estimateTokens(result.text).toLocaleString()}토큰).` +
          (result.unchanged > 0
            ? ` 다만 ${result.unchanged}개 조각은 재시도 후에도 원문이 그대로 남았다 — 그 부분이 처리되지 않았음을 사용자에게 알려라.`
            : '')
      )
    } catch (e) {
      if (abort.signal.aborted) finishTask(win, info, 'cancelled', '사용자 요청으로 취소되었습니다.')
      else finishTask(win, info, 'failed', describeError(e))
    }
  })()

  return { ...info }
}

/** 좁은 컨텍스트(로컬 모델)용 축약 워커 프롬프트 — 지켜지지 않으면 보고가 망가지는 규칙만 남긴다 */
function compactWorkerPrompt(): string {
  return [
    '너는 데스크톱 에이전트의 백그라운드 워커다. 위임받은 작업을 도구(파일, 셸, HTTP, MCP)로 끝까지 수행한다.',
    `실행 환경: ${platform()} / 홈: ${homedir()} / 현재 시각: ${new Date().toLocaleString()}`,
    '사소한 정보 부족은 합리적인 기본값으로 진행하고 보고에 밝혀라. 되돌리기 어려운 갈림길에서는 ask_user로 물어라.',
    '도구 호출의 purpose에는 "왜 지금 필요한지"를 한 문장 써라. 비워두지 마라. 승인이 거부되면 다른 방법을 찾거나 중단하고 이유를 보고하라.',
    '위에 정의된 도구만 호출하라. 없는 이름을 지어내지 마라.',
    '',
    '## 보고',
    '- 마지막 응답이 결과 보고다. 결론을 첫 문단에 쓰고 근거는 그 뒤에 둔다.',
    '- 실제로 실행한 명령과 그 출력만 근거로 삼아라. 확인하지 못한 값은 "확인 못함"이라고 적어라.',
    '- 값마다 어디서 나왔는지(파일 경로·명령)를 옆에 적어라. 확인 없이 아는 대로 쓴 것은 "일반 지식"이라고 표시하라.',
    '- 최신 버전·가격·API 스펙처럼 변하는 값은 네 지식으로 채우지 말고 http_request로 공식 JSON API에서 확인하라.',
    '- 간결하게, 위임 지시와 같은 언어로 쓴다.'
  ].join('\n')
}

function workerPrompt(): string {
  return [
    '너는 데스크톱 에이전트의 백그라운드 워커다. 메인 에이전트가 위임한 작업을 도구(파일, 셸, HTTP, MCP)로 끝까지 수행한다.',
    `실행 환경: ${platform()} / 홈 디렉토리: ${homedir()}`,
    `현재 시각: ${new Date().toString()}`,
    '사소한 정보 부족은 합리적인 기본값을 선택하고 결과 보고에 그 선택을 명시하라. ' +
      '그러나 되돌리기 어렵거나 사용자의 취향·판단이 필요한 갈림길(파일 덮어쓰기, 형식·범위 선택, 중요한 결정)에서는 ask_user로 사용자에게 물어라.',
    '외부 서비스 API는 http_request로 호출하고, 인증 토큰은 {{secret:이름}} 플레이스홀더로 참조하라 ' +
      '(저장 여부는 list_secrets로 확인, 없으면 request_secret으로 사용자에게 요청 — 토큰을 채팅으로 받지 마라).',
    '네 학습 지식은 과거 시점에 멈춰 있다. 최신 버전·릴리스·가격·API 스펙처럼 시간에 따라 변하는 값은 기억으로 채우지 말고 ' +
      'http_request로 1차 출처의 JSON API에서 확인하라(예: `https://registry.npmjs.org/<패키지>/latest`, `https://api.github.com/repos/<소유자>/<저장소>/releases/latest`). ' +
      '검색이 필요하면 등록된 검색 MCP 도구(이름에 search가 들어간 mcp_* 도구)를 쓰고, 그런 도구가 없으면 URL을 지어내지 말고 ' +
      '보고에 "확인 못함"으로 남겨라.',
    'mcp_로 시작하는 도구는 등록된 MCP 서버의 기능이다. 해당 서비스 작업에 적극 활용하라.',
    '도구 호출은 사용자 승인을 거치며, 승인 화면에는 네가 쓴 purpose가 그대로 표시된다. ' +
      'purpose를 비워두지 말고, 명령을 되풀이하는 대신 "왜 지금 필요한지"를 사용자의 언어로 한 문장으로 써라. ' +
      '되돌리기 어려운 작업(덮어쓰기·삭제·설치·외부 전송)은 무엇이 바뀌는지도 함께 밝혀라.',
    '도구 승인이 거부되면 다른 방법을 시도하거나, 불가능하면 중단하고 이유를 보고하라. 같은 요청을 그대로 반복하지 마라.',
    '',
    '## 결과 보고 규칙',
    '- 마지막 응답이 결과 보고다. 보고 전체가 메인 에이전트에게 전달되지만, 앞부분이 가장 확실하게 읽힌다.',
    '- 반드시 결론부터 써라. 첫 문단에 위임받은 질문에 대한 답 또는 핵심 발견을 쓰고, 근거·과정은 그 뒤에 둔다.',
    '- 실제로 실행한 명령과 그 출력만 근거로 삼아라. 확인하지 않은 값(버전, 파일 크기, 개수, 경로)을 지어내 표에 채우지 마라. 확인하지 못한 항목은 "확인 못함"이라고 적어라.',
    '- 각 값·발견 옆에 그것이 나온 자리를 밝혀라 — 어느 파일 경로, 어느 명령, 어느 URL인지. 메인 에이전트는 이 보고만 보고 사용자에게 출처를 전달한다.',
    '- 도구 없이 네 일반 지식으로 채운 부분이 있으면 "일반 지식(확인 안 함)"이라고 표시하라.',
    '- 보고 안에서 스스로 모순되지 않게 하라. 명령이 결과 없음(exit 1)을 냈다면 그 항목은 "없음"이다.',
    '- 기억(지식베이스)은 배경 참고일 뿐이다. 이번에 직접 확인한 사실보다 앞세우지 말고, 기억 내용을 조사 결과인 것처럼 보고하지 마라.',
    '- 간결하게 써라. 표와 강조는 실제로 비교가 필요할 때만. 장식용 이모지는 쓰지 마라.',
    '- 위임 지시와 같은 언어로 작성하라. 한 보고 안에 다른 언어의 문자를 섞지 마라.',
    '- 보고에는 무엇을 했고, 무엇이 만들어졌으며, 미완이 있다면 무엇이 남았는지가 포함되어야 한다.'
  ].join('\n')
}

const MAX_LOG_ITEMS = 80
const MAX_TEXT_PER_BLOCK = 4000
const TEXT_EMIT_INTERVAL_MS = 400

async function runTask(win: BrowserWindow, taskId: string, instruction: string): Promise<void> {
  const t = tasks.get(taskId)
  if (!t) return
  const { info, abort } = t
  const ctx: TurnContext = {
    sessionId: info.sessionId,
    win,
    failures: [],
    unattended: info.unattended
  }

  // 워커 활동 로그 — 메인 에이전트 대화처럼 텍스트 블록과 도구 카드가 순서대로 쌓인다
  const log: ChatItem[] = []
  info.log = log
  const toolItems = new Map<string, ChatItem & { kind: 'tool' }>()
  let textBlock: (ChatItem & { kind: 'assistant' }) | null = null
  let lastTextEmit = 0
  let finalText = ''

  try {
    const { model, config, profile } = await resolveModelFor(info.tier ?? 'standard')
    ctx.resultChars = profile.toolResultChars

    const base = profile.local ? compactWorkerPrompt() : workerPrompt()
    // 지식베이스는 남는 예산의 일부만 쓴다 — 지시와 도구 결과가 먼저다
    const memoryBudget = profile.local
      ? Math.max(0, Math.floor((profile.promptBudget - estimateTokens(base + instruction)) * 0.25))
      : undefined
    const memoryContext =
      memoryBudget === 0 ? '' : buildMemoryContext(instruction, { budgetTokens: memoryBudget })
    const system = memoryContext ? `${base}\n\n${memoryContext}` : base

    const clarify = clarifyTool({
      win,
      taskId: info.id,
      taskTitle: info.title,
      abortSignal: abort.signal,
      onWaiting: (waiting) => {
        info.detail = waiting ? '사용자 답변 대기 중…' : undefined
        emit(win, info)
      }
    })

    // MCP 도구는 연결이 필요하므로 비동기 수집 — 연결 실패 서버는 건너뛴다
    const mcpTools = await mcpToolsFor(ctx)

    const result = streamText({
      model,
      system,
      prompt: instruction,
      tools: {
        ...buildTools(ctx),
        ...clarify,
        ...integrationTools(win, info.sessionId),
        ...mcpTools
      },
      stopWhen: stepCountIs(profile.maxSteps),
      ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      abortSignal: abort.signal
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        finalText += part.text
        if (!textBlock || log[log.length - 1] !== textBlock) {
          textBlock = { kind: 'assistant', text: '' }
          log.push(textBlock)
        }
        if (textBlock.text.length < MAX_TEXT_PER_BLOCK) textBlock.text += part.text
        // 텍스트는 스로틀해 전송 (이벤트 폭주 방지)
        if (Date.now() - lastTextEmit > TEXT_EMIT_INTERVAL_MS) {
          lastTextEmit = Date.now()
          emit(win, info)
        }
      } else if (part.type === 'tool-call') {
        const def = toolDefByName(part.toolName)
        const i = (part.input ?? {}) as Record<string, unknown>
        const summary = def
          ? def.describeCall(part.input as never)
          : part.toolName === 'ask_user'
            ? `사용자에게 질문: ${String(i.question ?? '')}`
            : part.toolName === 'request_secret'
              ? `시크릿 입력 요청: ${String(i.name ?? '')}`
              : part.toolName === 'add_mcp_server'
                ? `MCP 서버 등록: ${String(i.name ?? '')}`
                : part.toolName.startsWith('mcp_')
                  ? `MCP 도구: ${part.toolName.slice(4)}`
                  : part.toolName
        const item: ChatItem & { kind: 'tool' } = {
          kind: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          summary,
          status: 'running'
        }
        toolItems.set(part.toolCallId, item)
        if (log.length < MAX_LOG_ITEMS) log.push(item)
        textBlock = null
        info.detail = summary
        emit(win, info)
      } else if (part.type === 'tool-result') {
        const output = JSON.stringify(part.output)
        const item = toolItems.get(part.toolCallId)
        if (item) {
          item.status = output.includes('"denied":true')
            ? 'denied'
            : output.includes('"error":')
              ? 'error'
              : 'done'
          item.output = output.slice(0, 2000)
        }
        emit(win, info)
      } else if (part.type === 'tool-error') {
        // 없는 도구 이름·스키마 불일치. SDK가 오류를 모델에 되돌려 주므로 작업은 이어지지만,
        // 카드를 확정하지 않으면 '실행 중'으로 굳는다.
        const message = part.error instanceof Error ? part.error.message : String(part.error)
        const item = toolItems.get(part.toolCallId)
        if (item) {
          item.status = 'error'
          item.output = message.slice(0, 2000)
        }
        ctx.failures.push({ kind: 'tool-error', detail: `${part.toolName} — ${message.slice(0, 200)}` })
        emit(win, info)
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }
    const totalUsage = await result.totalUsage
    const rec = recordUsage(
      { sessionId: info.sessionId, kind: 'task', provider: config.label, model: config.model, tier: info.tier },
      totalUsage
    )
    addSessionUsage(info.sessionId, rec.inputTokens, rec.outputTokens)
    info.usage = { input: rec.inputTokens, output: rec.outputTokens }
    finishTask(win, info, 'done', finalText.trim() || '작업이 완료되었습니다.')
  } catch (e) {
    // 중단·오류 시 아직 '실행 중'인 도구 카드를 확정해 로그가 모순 없이 남게 한다
    for (const item of toolItems.values()) {
      if (item.status === 'running') item.status = 'aborted'
    }
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

/**
 * @param historyNote 메인 에이전트 히스토리에 넣을 대체 문구. 결과 본문이 창을 넘길 만큼
 *   클 때(문서 분할 처리 결과 등) 카드에는 전문을 남기고 모델에게는 이 요약만 전달한다.
 */
function finishTask(
  win: BrowserWindow,
  info: TaskInfo,
  status: TaskStatus,
  result: string,
  historyNote?: string
): void {
  info.status = status
  // 메인 에이전트가 이 본문만 보고 사용자에게 답하므로, 결론이 잘려나가지 않을 만큼 넉넉히 남긴다.
  // 단 historyNote가 있으면 카드용 전문은 그대로 두고 모델에게만 요약을 준다.
  info.result = historyNote ? result : result.slice(0, 6000)
  info.detail = undefined
  info.finishedAt = new Date().toISOString()
  emit(win, info)
  // 취소는 사용자가 직접 한 행동이므로 알리지 않는다
  if (status !== 'cancelled') {
    notifyIfBackground(win, `작업 ${STATUS_LABEL[status]}: ${info.title}`, info.result, {
      kind: 'task',
      sessionId: info.sessionId
    })
  }

  // 결과 카드(작업 과정 로그 포함)를 대화에 남기고,
  // 메인 에이전트가 다음 턴에서 결과를 인지하도록 알림 메시지를 히스토리에 추가
  appendToSession(
    info.sessionId,
    [
      {
        kind: 'task',
        taskId: info.id,
        title: info.title,
        status,
        result: info.result,
        log: info.log?.map((x) => ({ ...x })),
        ...(info.usage ? { usage: info.usage } : {})
      }
    ],
    [
      {
        role: 'user',
        content: historyNote
          ? `[작업 알림 — 시스템 자동 메시지] 백그라운드 작업 "${info.title}" ${STATUS_LABEL[status]}.\n` +
            `${historyNote}\n\n` +
            '(결과 전문은 사용자 화면의 카드에 이미 표시되었다. 전문을 다시 출력하려 하지 마라 — ' +
            '네 컨텍스트에 담기지 않는다. 무엇을 했는지 한두 문장으로만 알려라.)'
          : `[작업 알림 — 시스템 자동 메시지] 백그라운드 작업 "${info.title}" ${STATUS_LABEL[status]}.\n` +
            `결과 전문:\n${info.result}\n\n` +
            '(원문 카드는 사용자 화면에 이미 표시되었다. 원문을 되풀이하지 말고, ' +
            '이 결과가 사용자의 원래 질문에 대해 무엇을 뜻하는지 해석해서 답하라. ' +
            '앞선 작업 결과와 모순되면 모순을 짚고 어느 쪽이 맞는지 직접 확인한 뒤 답하라. ' +
            `보고에 적힌 근거(파일 경로·명령·URL)는 사용자에게 출처로 넘겨라 — 최소한 작업 "${info.title}"에서 나온 결과임을 밝혀라.)`
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
        instruction: z.string().describe('서브 에이전트가 단독 수행할 수 있는 상세하고 자기완결적인 지시'),
        tier: z
          .enum(['light', 'standard', 'advanced'])
          .optional()
          .describe(
            '모델 등급: light=단순 수집·정리·기계적 작업, standard=일반 작업(기본값), advanced=복잡한 분석·코드 작성·중요 문서'
          )
      }),
      execute: async ({ title, instruction, tier }) => {
        try {
          const info = startTask(win, sessionId, title, instruction, tier ?? 'standard')
          return { taskId: info.id, status: info.status, tier: info.tier }
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
