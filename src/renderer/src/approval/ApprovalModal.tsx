import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '@shared/types'

const RISK_LABEL: Record<string, string> = {
  read: '읽기',
  write: '쓰기',
  execute: '실행',
  elevate: '관리자 권한'
}

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

  const elevate = current.elevate === true

  return (
    <div className="overlay">
      <div className={elevate ? 'dialog elevate' : 'dialog'}>
        <h3>
          {elevate ? '에이전트가 관리자 권한을 요청합니다' : '에이전트가 권한을 요청합니다'}
          <span className={`risk ${current.risk}`}>{RISK_LABEL[current.risk]}</span>
        </h3>
        {elevate && (
          <div className="elevate-note">
            허용하면 <strong>OS 인증 창</strong>이 뜹니다. 비밀번호는 운영체제가 직접 받으며
            에이전트와 이 앱은 볼 수 없습니다. 이 승인은 <strong>이번 한 번</strong>만 유효하고
            규칙으로 저장되지 않습니다.
          </div>
        )}
        <div className="approval-purpose">
          <span className="label">왜 필요한가</span>
          {current.purpose ? (
            <p>{current.purpose}</p>
          ) : (
            <p className="missing">에이전트가 목적을 밝히지 않았습니다. 판단이 어려우면 거부하세요.</p>
          )}
        </div>
        <div className="approval-what">
          <span className="label">실행할 내용</span>
          <p>{current.summary}</p>
        </div>
        {elevate && current.argv && (
          <div className="approval-what">
            <span className="label">관리자 권한으로 실행될 인자</span>
            <pre className="argv">{current.argv.map((a, n) => `[${n}] ${a}`).join('\n')}</pre>
          </div>
        )}
        <pre>{current.input}</pre>
        {current.lessons.length > 0 && (
          <div className="lessons">
            관련 교훈 기록: {current.lessons.join(' · ')}
          </div>
        )}
        {!elevate && (
          <div className="pattern-row">
            <span>허용 패턴</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </div>
        )}
        <div className="actions">
          <button className="danger" onClick={() => respond('deny', 'once')}>
            거부
          </button>
          <button onClick={() => respond('allow', 'once')}>
            {elevate ? '이번 한 번 허용 (OS 인증 창으로)' : '이번만 허용'}
          </button>
          {/* 상승 승인에는 세션·영구 범위가 존재하지 않는다 — 매번 사람이 그 자리에서 승인해야 한다 */}
          {!elevate && (
            <>
              <button onClick={() => respond('allow', 'session')}>이 세션에서 허용</button>
              <button className="primary" onClick={() => respond('allow', 'always')}>
                항상 허용
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
