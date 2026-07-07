import { useEffect, useState } from 'react'
import type { NetworkApproval } from '@shared/api'

/** 페어링 요청과 수신 작업 위임 승인을 처리하는 다이얼로그 */
export default function NetworkApprovalModal(): JSX.Element | null {
  const [queue, setQueue] = useState<NetworkApproval[]>([])

  useEffect(() => {
    return window.api.onNetworkApproval((a) => setQueue((q) => [...q, a]))
  }, [])

  const current = queue[0]
  if (!current) return null

  const respond = (approved: boolean): void => {
    void window.api.netRespondApproval(current.requestId, approved)
    setQueue((q) => q.slice(1))
  }

  return (
    <div className="overlay">
      <div className="dialog">
        <h3>
          {current.kind === 'pair' ? '에이전트 연결 요청' : '원격 작업 요청'}
          <span className="risk execute">네트워크</span>
        </h3>
        <div style={{ whiteSpace: 'pre-wrap' }}>{current.title}</div>
        <pre>{current.detail}</pre>
        <div className="lessons">
          이 요청은 다른 사용자의 에이전트에서 왔습니다. 신뢰하는 상대만 허용하세요. 개인정보·자격증명은 공유되지 않습니다.
        </div>
        <div className="actions">
          <button className="danger" onClick={() => respond(false)}>
            거부
          </button>
          <button className="primary" onClick={() => respond(true)}>
            허용
          </button>
        </div>
      </div>
    </div>
  )
}
