import type { BrowserWindow } from 'electron'
import type { ApprovalDecision, ApprovalRequest, AuditRecord, RiskLevel } from '@shared/types'
import { addRule, evaluate } from './policies'
import { logAudit } from './audit'
import {
  ELEVATION_APPROVAL_TIMEOUT_MS,
  isElevationEnabled,
  userIsPresent
} from './elevation'
import { searchLessons } from '../memory/store'
import { notifyIfBackground } from '../notify'

/** 규칙과 무관하게 항상 차단하는 파괴적 명령 (셸 도구용) */
const HARD_BLOCKLIST = [
  /rm\s+(-[a-z]*\s+)*(\/|~\/?$|\/\*)/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
  /shutdown|reboot\s/i,
  /format\s+[a-z]:/i,
  /del\s+\/[sq]\s+[a-z]:\\/i
]

export function isHardBlocked(command: string): boolean {
  return HARD_BLOCKLIST.some((re) => re.test(command))
}

/**
 * shell_exec으로 권한을 상승시키려는 시도. 명령 어디에 있든(파이프·서브셸·백틱 뒤에 숨어도)
 * 잡아서 차단한다. 우회로가 하나라도 남으면 상승 경로의 나머지 방어가 전부 무의미해진다.
 * 상승이 정말 필요하면 shell_exec_elevated로만 갈 수 있다.
 */
const ELEVATION_ATTEMPT =
  /(^|[\s;&|(){}'"`$=])(sudo|doas|pkexec|runas|su)(\s|$)|Start-Process[^|]*-Verb\s+RunAs|with\s+administrator\s+privileges/i

/**
 * 인용 분할 우회를 지운다. 셸은 `su''do`·`s\udo`·`"sud"o`를 모두 sudo로 이어붙이지만
 * 정규식은 리터럴을 보므로 그냥 통과한다 — 실제로 에이전트가 차단당한 뒤 이 방법을 찾아
 * 스스로 우회했다(감사 로그에 남아 있다). 따옴표와 백슬래시를 지우고 한 번 더 보면
 * 이 계열이 한꺼번에 잡힌다.
 *
 * 변수 조립(`X=su; Y=do; $X$Y id`)까지는 문자열 검사로 막을 수 없다. 그건 shell_exec을
 * no_new_privs 아래에서 실행하는 쪽(tools/shell.ts)이 커널 수준에서 막는다.
 */
function stripQuoting(command: string): string {
  return command.replace(/['"\\]/g, '')
}

export function isElevationAttempt(command: string): boolean {
  return ELEVATION_ATTEMPT.test(command) || ELEVATION_ATTEMPT.test(stripQuoting(command))
}

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingApproval>()

export function respondToApproval(requestId: string, decision: ApprovalDecision): void {
  const p = pending.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(requestId)
  p.resolve(decision)
}

function askUser(
  win: BrowserWindow,
  req: ApprovalRequest,
  sessionId: string,
  timeoutMs = 5 * 60 * 1000
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.requestId)
      resolve({ action: 'deny', scope: 'once', reason: '승인 요청 시간 초과' })
    }, timeoutMs)
    pending.set(req.requestId, { resolve, timer })
    win.webContents.send('approval:request', req)
    notifyIfBackground(win, '도구 실행 승인 필요', req.summary, { kind: 'approval', sessionId })
  })
}

export interface GateInput {
  sessionId: string
  toolName: string
  risk: RiskLevel
  summary: string
  /** 규칙 매칭 대상 (파일 경로 또는 명령 문자열) */
  target: string
  suggestedPattern: string
  inputJson: string
  /** 에이전트가 밝힌 요청 목적 — 승인 다이얼로그와 감사 기록에 함께 남는다 */
  purpose?: string
  /** 사람이 지켜보지 않는 경로(스케줄·피어 위임)에서 온 호출 — 권한 상승이 금지된다 */
  unattended?: boolean
  /** risk가 elevate일 때 root로 넘어갈 인자 배열 */
  argv?: string[]
}

export interface GateResult {
  allowed: boolean
  reason?: string
}

/** 거부를 감사에 남기고 그대로 돌려준다 */
function refuse(
  g: GateInput,
  decision: AuditRecord['decision'],
  reason: string
): GateResult {
  logAudit({
    at: new Date().toISOString(),
    sessionId: g.sessionId,
    toolName: g.toolName,
    summary: g.summary,
    decision,
    result: 'denied',
    purpose: g.purpose,
    ...(g.risk === 'elevate' ? { elevated: true, argv: g.argv } : {})
  })
  return { allowed: false, reason }
}

/**
 * 관리자 권한 요청 전용 경로.
 *
 * 권한 규칙(allow/deny 패턴)을 조회하지도, 만들지도 않는다 — 상승에는 "이 세션에서 허용"과
 * "항상 허용"이 존재하지 않는다. 한 번 저장된 규칙은 사람이 없는 시각에도 발동하는데,
 * 그것이 정확히 이 경로에서 막아야 할 일이기 때문이다.
 * 비밀번호는 이 함수를 포함해 앱의 어느 코드도 보지 않는다 — 승인 뒤 OS가 직접 받는다.
 */
async function checkElevated(win: BrowserWindow, g: GateInput): Promise<GateResult> {
  if (!isElevationEnabled()) {
    return refuse(
      g,
      'blocked',
      '권한 상승 기능이 꺼져 있습니다. 사용자가 설정 > 권한 상승에서 직접 켜야 합니다.'
    )
  }
  if (g.unattended) {
    return refuse(
      g,
      'blocked-unattended',
      '사람이 지켜보지 않는 작업(예약 실행·다른 에이전트의 위임)에서는 관리자 권한을 쓸 수 없습니다. ' +
        '사용자에게 직접 요청하도록 결과를 보고하라.'
    )
  }
  if (!userIsPresent(win)) {
    return refuse(
      g,
      'blocked-unattended',
      '앱 창이 보이지 않아 사용자 승인을 받을 수 없습니다. 창이 열려 있을 때 다시 요청하라.'
    )
  }

  // 승인 창을 사용자 앞으로 — 놓치면 2분 뒤 자동 거부된다
  win.focus()

  const lessons = searchLessons(`${g.toolName} ${g.summary}`, 3).map((m) => m.title)
  const decision = await askUser(
    win,
    {
      requestId: crypto.randomUUID(),
      toolName: g.toolName,
      summary: g.summary,
      risk: g.risk,
      input: g.inputJson,
      suggestedPattern: g.suggestedPattern,
      lessons,
      purpose: g.purpose,
      elevate: true,
      argv: g.argv
    },
    g.sessionId,
    ELEVATION_APPROVAL_TIMEOUT_MS
  )

  // decision.scope는 의도적으로 무시한다 — 상승 승인은 규칙으로 저장되지 않는다
  if (decision.action !== 'allow') {
    return refuse(g, 'denied-by-user', decision.reason || '사용자가 거부했습니다.')
  }

  logAudit({
    at: new Date().toISOString(),
    sessionId: g.sessionId,
    toolName: g.toolName,
    summary: g.summary,
    decision: 'allowed-by-user',
    result: 'ok',
    purpose: g.purpose,
    elevated: true,
    argv: g.argv
  })
  notifyIfBackground(win, '관리자 권한으로 실행합니다', g.summary, {
    kind: 'approval',
    sessionId: g.sessionId
  })
  return { allowed: true }
}

/** 모든 도구 호출이 통과하는 단일 관문 */
export async function checkPermission(win: BrowserWindow, g: GateInput): Promise<GateResult> {
  // 0. 상승 요청은 규칙 계층을 아예 거치지 않는 별도 경로로 간다
  if (g.risk === 'elevate') return checkElevated(win, g)

  // 1. 하드 블록 (execute 도구의 파괴적 명령, 그리고 모든 권한 상승 시도)
  if (g.toolName === 'shell_exec' && isElevationAttempt(g.target)) {
    return refuse(
      g,
      'blocked',
      'shell_exec으로는 권한을 상승시킬 수 없습니다(sudo/su/pkexec/runas 차단). ' +
        '명령 문자열 전체를 보므로, 파일에 써 넣을 내용에 그 단어가 들어 있어도 걸린다 — ' +
        '그런 경우라면 리다이렉션(>) 대신 fs_write로 파일을 써라. ' +
        '실제로 관리자 권한이 필요한 것이면 shell_exec_elevated 도구로 요청하라 — ' +
        '사용자가 그 자리에서 승인하고 OS 인증 창에 직접 비밀번호를 입력하게 된다.'
    )
  }
  if (g.toolName === 'shell_exec' && isHardBlocked(g.target)) {
    return refuse(g, 'blocked', '파괴적 명령으로 분류되어 차단되었습니다.')
  }

  // 2. 정책 규칙 (deny 우선)
  const verdict = evaluate(g.toolName, g.target)
  if (verdict === 'deny') {
    return refuse(g, 'denied-by-rule', '차단 규칙에 의해 거부되었습니다.')
  }
  if (verdict === 'allow') {
    logAudit({
      at: new Date().toISOString(),
      sessionId: g.sessionId,
      toolName: g.toolName,
      summary: g.summary,
      decision: 'allowed-by-rule',
      result: 'ok',
      purpose: g.purpose
    })
    return { allowed: true }
  }

  // 3. 사용자에게 질문 — 유사 교훈이 있으면 다이얼로그에 함께 표시
  const lessons = searchLessons(`${g.toolName} ${g.summary}`, 3).map((m) => m.title)
  const decision = await askUser(
    win,
    {
      requestId: crypto.randomUUID(),
      toolName: g.toolName,
      summary: g.summary,
      risk: g.risk,
      input: g.inputJson,
      suggestedPattern: g.suggestedPattern,
      lessons,
      purpose: g.purpose
    },
    g.sessionId
  )

  if (decision.action === 'allow' && (decision.scope === 'session' || decision.scope === 'always')) {
    addRule({
      toolName: g.toolName,
      pattern: decision.pattern || g.suggestedPattern,
      action: 'allow',
      scope: decision.scope
    })
  }

  logAudit({
    at: new Date().toISOString(),
    sessionId: g.sessionId,
    toolName: g.toolName,
    summary: g.summary,
    decision: decision.action === 'allow' ? 'allowed-by-user' : 'denied-by-user',
    result: decision.action === 'allow' ? 'ok' : 'denied',
    purpose: g.purpose
  })

  return decision.action === 'allow'
    ? { allowed: true }
    : { allowed: false, reason: decision.reason || '사용자가 거부했습니다.' }
}
