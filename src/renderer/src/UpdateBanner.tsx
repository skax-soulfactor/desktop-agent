import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/** "이 버전은 나중에" 로 미룬 버전 — 다음 버전이 나오면 다시 안내한다 */
const SKIP_KEY = 'update-skipped-version'

interface Props {
  /** 배너를 닫은 뒤에도 업데이트를 다시 찾을 수 있는 곳 */
  onOpenSettings: () => void
}

/**
 * 앱을 켰을 때 새 버전이 있으면 알려 주는 배너.
 * 확인은 자동으로 하되 내려받기·설치는 여기서 사용자가 직접 고른다.
 * (미루면 그 버전은 다시 뜨지 않고, 설정 화면에서 언제든 다시 진행할 수 있다.)
 */
export default function UpdateBanner({ onOpenSettings }: Props): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [skipped, setSkipped] = useState(() => localStorage.getItem(SKIP_KEY) ?? '')
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    // 사용자 결정이 필요한 시점(새 버전 발견·다운로드 완료)에는 접어 둔 배너를 다시 편다
    const apply = (s: UpdateStatus): void => {
      setStatus(s)
      if (s.state === 'available' || s.state === 'downloaded') setCollapsed(false)
    }
    void window.api.updateStatus().then(apply)
    return window.api.onUpdateStatus(apply)
  }, [])

  // 사용자 결정이 필요하거나 진행 상황을 보여 줄 상태에서만 배너를 띄운다
  const shown =
    status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded'
  if (!shown || collapsed) return null
  if (status.state === 'available' && status.version === skipped) return null

  const later = (): void => {
    // 진행 중·완료 상태에는 버전을 미루지 않고 배너만 접는다 (설정 화면에서 이어서 처리)
    if (status.state === 'available') {
      localStorage.setItem(SKIP_KEY, status.version)
      setSkipped(status.version)
    }
    setCollapsed(true)
  }

  return (
    <div className="update-banner">
      <span className="ic" aria-hidden="true">
        ⬆
      </span>
      {status.state === 'available' && (
        <>
          <span className="txt">
            새 버전 <strong>v{status.version}</strong>이(가) 있습니다. 지금 업데이트할까요?
          </span>
          <button className="go" onClick={() => void window.api.downloadUpdate()}>
            지금 업데이트
          </button>
          <button className="later" onClick={later}>
            나중에
          </button>
        </>
      )}
      {status.state === 'downloading' && (
        <span className="txt">새 버전을 내려받는 중… {status.percent}%</span>
      )}
      {status.state === 'downloaded' && (
        <>
          <span className="txt">
            새 버전 <strong>v{status.version}</strong> 준비 완료 — 재시작하면 설치됩니다.
          </span>
          <button className="go" onClick={() => void window.api.installUpdate()}>
            재시작하고 설치
          </button>
          <button className="later" onClick={later}>
            나중에
          </button>
        </>
      )}
      <button className="close" onClick={onOpenSettings} title="설정에서 업데이트 관리">
        설정
      </button>
    </div>
  )
}
