import type { BrowserWindow } from 'electron'
import { readJson, writeJson } from '../storage/jsonStore'

/**
 * 권한 상승의 정책 계층. 실제 실행은 tools/elevated.ts가 한다.
 *
 * 여기 있는 것은 "언제 물어봐도 되는가"의 판정뿐이다 — 비밀번호는 이 파일을 포함해
 * 앱의 어느 코드도 다루지 않는다. 자격증명 수집은 전적으로 OS(polkit/UAC/Authorization
 * Services)의 몫이고, 앱은 상승 실행의 성공 여부만 돌려받는다.
 * 설계 근거: docs/DESIGN-PRIVILEGE-ELEVATION.md
 */

export const ELEVATED_TOOL_NAME = 'shell_exec_elevated'

/** 상승 승인 대기 시간 — 일반 도구(5분)보다 짧다. 사람이 화면 앞에 있을 때만 뜨는 창이기 때문. */
export const ELEVATION_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000

interface ElevationSettings {
  enabled: boolean
}

const FILE = 'elevation.json'

/** 기본은 꺼짐 — 사용자가 설정에서 켜기 전까지 도구 정의가 LLM에 전달되지 않는다 */
export function isElevationEnabled(): boolean {
  return readJson<ElevationSettings>(FILE, { enabled: false }).enabled === true
}

export function setElevationEnabled(enabled: boolean): void {
  writeJson(FILE, { enabled })
}

/**
 * 사용자가 화면 앞에서 기다리고 있는가.
 * 승인 대화상자를 볼 수 없는 상태(창 없음·숨김·최소화)에서는 상승 요청을 아예 거부한다 —
 * 보이지 않는 창에 뜬 승인은 승인이 아니다.
 */
export function userIsPresent(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false
  return win.isVisible() && !win.isMinimized()
}
