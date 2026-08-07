import { useState } from 'react'
import { canOpenNotificationSettings } from './lib/platform'

const DISMISS_KEY = 'notif-hint-dismissed'

interface Props {
  /** 알림 화면으로 이동 — 배너를 닫은 뒤에도 설정과 지난 내역을 볼 수 있는 곳 */
  onOpenNotifications: () => void
}

/**
 * 처음 한 번 뜨는 알림 안내 배너.
 * macOS/Windows는 OS 설정에서 알림이 꺼져 있으면 백그라운드 작업 완료 알림이 오지 않는다.
 * (실제 권한 상태는 Electron API로 신뢰성 있게 알 수 없어, 감지 대신 닫기 전까지 1회 안내한다.)
 * 닫은 뒤에는 알림 화면에서 설정 열기와 지난 내역 확인을 언제든 할 수 있다.
 */
export default function NotifyHint({ onOpenNotifications }: Props): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')
  if (dismissed || !canOpenNotificationSettings) return null

  const close = (): void => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="notif-hint">
      <span className="ic" aria-hidden="true">
        🔔
      </span>
      <span className="txt">
        백그라운드 작업 완료를 알림으로 받으려면 시스템 설정에서 이 앱의 알림을 허용하세요.
      </span>
      <button className="open" onClick={() => void window.api.openNotificationSettings()}>
        알림 설정 열기
      </button>
      <button className="later" onClick={onOpenNotifications}>
        알림 내역
      </button>
      <button className="close" onClick={close} title="다시 보지 않기 (알림 탭에서 다시 열 수 있습니다)">
        ×
      </button>
    </div>
  )
}
