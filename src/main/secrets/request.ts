import type { BrowserWindow } from 'electron'
import type { SecretRequest } from '@shared/types'
import { setSecret } from './store'
import { notifyIfBackground } from '../notify'

/**
 * 에이전트가 시크릿 입력을 요청하면 renderer에 모달을 띄우고 답을 기다린다.
 * 사용자가 입력한 값은 IPC로 메인에 직접 전달되어 저장될 뿐, 도구 결과에는 저장 여부만 남는다
 * (clarify와 같은 대기 패턴, 값만 경로가 다르다).
 */

interface Pending {
  name: string
  resolve: (outcome: 'saved' | 'denied') => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
const openRequests: SecretRequest[] = []
const TIMEOUT_MS = 30 * 60 * 1000

export function pendingSecretRequests(): SecretRequest[] {
  return openRequests.slice()
}

/** renderer 응답 처리 — value가 null이면 사용자가 거부한 것 */
export function respondSecretRequest(requestId: string, value: string | null): void {
  const p = pending.get(requestId)
  if (!p) return
  if (value !== null && value.trim()) {
    setSecret(p.name, value.trim())
    finish(requestId, 'saved')
  } else {
    finish(requestId, 'denied')
  }
}

function finish(requestId: string, outcome: 'saved' | 'denied'): void {
  const p = pending.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(requestId)
  const idx = openRequests.findIndex((r) => r.requestId === requestId)
  if (idx >= 0) openRequests.splice(idx, 1)
  p.resolve(outcome)
}

export function requestSecretFromUser(
  win: BrowserWindow,
  name: string,
  purpose: string
): Promise<'saved' | 'denied' | 'timeout'> {
  if (win.isDestroyed()) return Promise.resolve('denied')
  const req: SecretRequest = { requestId: crypto.randomUUID(), name, purpose }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.requestId)
      const idx = openRequests.findIndex((r) => r.requestId === req.requestId)
      if (idx >= 0) openRequests.splice(idx, 1)
      resolve('timeout')
    }, TIMEOUT_MS)
    pending.set(req.requestId, { name, resolve, timer })
    openRequests.push(req)
    win.webContents.send('secret:request', req)
    notifyIfBackground(win, `시크릿 입력 요청: ${name}`, purpose)
  })
}
