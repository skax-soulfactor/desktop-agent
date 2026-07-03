import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '@shared/types'

const RISK_LABEL: Record<string, string> = { read: '읽기', write: '쓰기', execute: '실행' }

export default function ApprovalModal(): JSX.Element | null {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const [pattern, setPattern] = useState('')

  useEffect(() => {
    return window.api.onApprovalRequest((r) => {
      setQueue((q) => [...q, r])
    })
  }, [])

  const current = queue[0]

  useEffect(() => {
    if (current) setPattern(current.suggestedPattern)
  }, [current?.requestId])

  if (!current) return null

  const respond = (action: 'allow' | 'deny', scope: 'once' | 'session' | 'always'): void => {
    void window.api.approvalRespond(current.requestId, {
      action,
      scope,
      pattern: scope === 'once' ? undefined : pattern
    })
    setQueue((q) => q.slice(1))
  }

  return (
    <div className="overlay">
      <div className="dialog">
        <h3>
          에이전트가 권한을 요청합니다
          <span className={`risk ${current.risk}`}>{RISK_LABEL[current.risk]}</span>
        </h3>
        <div>{current.summary}</div>
        <pre>{current.input}</pre>
        {current.lessons.length > 0 && (
          <div className="lessons">
            관련 교훈 기록: {current.lessons.join(' · ')}
          </div>
        )}
        <div className="pattern-row">
          <span>허용 패턴</span>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </div>
        <div className="actions">
          <button className="danger" onClick={() => respond('deny', 'once')}>
            거부
          </button>
          <button onClick={() => respond('allow', 'once')}>이번만 허용</button>
          <button onClick={() => respond('allow', 'session')}>이 세션에서 허용</button>
          <button className="primary" onClick={() => respond('allow', 'always')}>
            항상 허용
          </button>
        </div>
      </div>
    </div>
  )
}
