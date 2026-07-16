import type { BrowserWindow } from 'electron'
import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '@shared/types'
import { addRule, evaluate } from './policies'
import { logAudit } from './audit'
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

function askUser(win: BrowserWindow, req: ApprovalRequest): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        pending.delete(req.requestId)
        resolve({ action: 'deny', scope: 'once', reason: '승인 요청 시간 초과' })
      },
      5 * 60 * 1000
    )
    pending.set(req.requestId, { resolve, timer })
    win.webContents.send('approval:request', req)
    notifyIfBackground(win, '도구 실행 승인 필요', req.summary)
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
}

export interface GateResult {
  allowed: boolean
  reason?: string
}

/** 모든 도구 호출이 통과하는 단일 관문 */
export async function checkPermission(win: BrowserWindow, g: GateInput): Promise<GateResult> {
  // 1. 하드 블록 (execute 도구의 파괴적 명령)
  if (g.toolName === 'shell_exec' && isHardBlocked(g.target)) {
    logAudit({
      at: new Date().toISOString(),
      sessionId: g.sessionId,
      toolName: g.toolName,
      summary: g.summary,
      decision: 'blocked',
      result: 'denied'
    })
    return { allowed: false, reason: '파괴적 명령으로 분류되어 차단되었습니다.' }
  }

  // 2. 정책 규칙 (deny 우선)
  const verdict = evaluate(g.toolName, g.target)
  if (verdict === 'deny') {
    logAudit({
      at: new Date().toISOString(),
      sessionId: g.sessionId,
      toolName: g.toolName,
      summary: g.summary,
      decision: 'denied-by-rule',
      result: 'denied'
    })
    return { allowed: false, reason: '차단 규칙에 의해 거부되었습니다.' }
  }
  if (verdict === 'allow') {
    logAudit({
      at: new Date().toISOString(),
      sessionId: g.sessionId,
      toolName: g.toolName,
      summary: g.summary,
      decision: 'allowed-by-rule',
      result: 'ok'
    })
    return { allowed: true }
  }

  // 3. 사용자에게 질문 — 유사 교훈이 있으면 다이얼로그에 함께 표시
  const lessons = searchLessons(`${g.toolName} ${g.summary}`, 3).map((m) => m.title)
  const decision = await askUser(win, {
    requestId: crypto.randomUUID(),
    toolName: g.toolName,
    summary: g.summary,
    risk: g.risk,
    input: g.inputJson,
    suggestedPattern: g.suggestedPattern,
    lessons
  })

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
    result: decision.action === 'allow' ? 'ok' : 'denied'
  })

  return decision.action === 'allow'
    ? { allowed: true }
    : { allowed: false, reason: decision.reason || '사용자가 거부했습니다.' }
}
