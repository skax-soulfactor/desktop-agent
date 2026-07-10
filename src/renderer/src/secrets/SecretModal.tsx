import { useEffect, useState } from 'react'
import type { SecretRequest } from '@shared/types'

/**
 * 에이전트가 시크릿(API 토큰 등)을 요청할 때 뜨는 입력 모달.
 * 입력값은 IPC로 메인 프로세스에 직접 전달되어 키체인에 저장될 뿐,
 * LLM 대화나 화면 기록에는 남지 않는다.
 */
export default function SecretModal(): JSX.Element | null {
  const [queue, setQueue] = useState<SecretRequest[]>([])
  const [value, setValue] = useState('')

  useEffect(() => {
    void window.api.secretPending().then((list) => setQueue((q) => mergeUnique(q, list)))
    return window.api.onSecretRequest((r) => setQueue((q) => mergeUnique(q, [r])))
  }, [])

  const current = queue[0]

  useEffect(() => {
    setValue('')
  }, [current?.requestId])

  if (!current) return null

  const respond = (v: string | null): void => {
    void window.api.secretRespond(current.requestId, v)
    setQueue((q) => q.slice(1))
  }

  return (
    <div className="overlay">
      <div className="dialog">
        <h3>
          시크릿 입력 요청
          <span className="risk write">보안</span>
        </h3>
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          저장될 이름: <code>{current.name}</code>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{current.purpose}</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          입력한 값은 OS 키체인에 암호화 저장되며, 에이전트(LLM)와 대화 기록에는 노출되지 않습니다.
        </div>
        <input
          autoFocus
          type="password"
          value={value}
          placeholder="토큰/키 값 붙여넣기"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) respond(value)
          }}
        />
        <div className="actions">
          <button onClick={() => respond(null)}>거부</button>
          <button className="primary" disabled={!value.trim()} onClick={() => respond(value)}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

function mergeUnique(a: SecretRequest[], b: SecretRequest[]): SecretRequest[] {
  const seen = new Set(a.map((r) => r.requestId))
  return [...a, ...b.filter((r) => !seen.has(r.requestId))]
}
