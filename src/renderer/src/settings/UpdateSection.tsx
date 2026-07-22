import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/** 업데이트 상태를 사용자 문구로 변환 */
function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'idle':
      return '버튼을 눌러 새 버전을 확인하세요.'
    case 'checking':
      return '업데이트를 확인하고 있습니다…'
    case 'available':
      return `새 버전 v${s.version}을(를) 찾았습니다. 내려받는 중…`
    case 'not-available':
      return '최신 버전을 사용하고 있습니다.'
    case 'downloading':
      return `새 버전을 내려받는 중… ${s.percent}%`
    case 'downloaded':
      return `새 버전 v${s.version} 준비 완료 — 재시작하면 설치됩니다.`
    case 'error':
      return `업데이트 확인 중 오류가 발생했습니다: ${s.message}`
    case 'unsupported':
      return s.message
  }
}

export default function UpdateSection(): JSX.Element {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    void window.api.getAppVersion().then(setVersion)
    void window.api.updateStatus().then(setStatus)
    return window.api.onUpdateStatus(setStatus)
  }, [])

  const check = async (): Promise<void> => {
    setStatus({ state: 'checking' })
    setStatus(await window.api.checkForUpdates())
  }

  const busy = status.state === 'checking' || status.state === 'downloading'
  const isError = status.state === 'error'

  return (
    <>
      <h2>앱 정보 및 업데이트</h2>
      <div className="card">
        <div className="update-row">
          <div className="update-info">
            <div className="update-ver">
              현재 버전 <strong>v{version || '…'}</strong>
            </div>
            <div className={`update-msg ${isError ? 'err' : ''}`}>{describe(status)}</div>
          </div>
          <div className="update-actions">
            {status.state === 'downloaded' ? (
              <button onClick={() => void window.api.installUpdate()}>재시작하고 설치</button>
            ) : (
              <button onClick={() => void check()} disabled={busy}>
                {busy ? '확인 중…' : '업데이트 확인'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
