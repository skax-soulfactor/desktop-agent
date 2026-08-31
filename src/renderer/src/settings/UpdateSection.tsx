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
      return `새 버전 v${s.version}을(를) 사용할 수 있습니다. 내려받을지 직접 선택하세요.`
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
    const off = window.api.onUpdateStatus(setStatus)
    // 화면을 열면 새 버전 유무만 자동으로 확인한다 — 내려받기·설치는 아래 버튼으로 사용자가 결정
    void window.api.updateStatus().then((s) => {
      setStatus(s)
      // 이미 내려받는 중이거나 설치를 기다리는 중이면 방해하지 않는다
      if (s.state === 'downloading' || s.state === 'downloaded') return
      void window.api.checkForUpdates().then(setStatus)
    })
    return off
  }, [])

  const check = async (): Promise<void> => {
    setStatus({ state: 'checking' })
    setStatus(await window.api.checkForUpdates())
  }

  const busy = status.state === 'checking' || status.state === 'downloading'

  return (
    <>
      <h2>앱 정보 및 업데이트</h2>
      <div className="card">
        <div className="update-row">
          <div className="update-info">
            <div className="update-ver">
              현재 버전 <strong>v{version || '…'}</strong>
            </div>
            <div className={`update-msg ${status.state === 'error' ? 'err' : ''}`}>
              {describe(status)}
            </div>
          </div>
          <div className="update-actions">
            {status.state === 'downloaded' ? (
              <button onClick={() => void window.api.installUpdate()}>재시작하고 설치</button>
            ) : status.state === 'available' ? (
              <>
                <button onClick={() => void window.api.downloadUpdate()}>지금 업데이트</button>
                <button className="ghost" onClick={() => void check()}>
                  다시 확인
                </button>
              </>
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
