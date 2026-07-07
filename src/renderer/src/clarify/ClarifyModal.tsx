import { useEffect, useState } from 'react'
import type { ClarifyRequest } from '@shared/types'

/** 워커가 작업 중 사용자 의견을 물을 때 뜨는 입력 인터페이스 */
export default function ClarifyModal(): JSX.Element | null {
  const [queue, setQueue] = useState<ClarifyRequest[]>([])
  const [text, setText] = useState('')

  useEffect(() => {
    // 창을 다시 열었을 때 대기 중인 질문 복원
    void window.api.clarifyPending().then((list) => setQueue((q) => mergeUnique(q, list)))
    return window.api.onClarifyRequest((r) => setQueue((q) => mergeUnique(q, [r])))
  }, [])

  const current = queue[0]

  useEffect(() => {
    setText('')
  }, [current?.requestId])

  if (!current) return null

  const answer = (value: string): void => {
    if (!value.trim()) return
    void window.api.clarifyRespond(current.requestId, value)
    setQueue((q) => q.slice(1))
  }

  return (
    <div className="overlay">
      <div className="dialog">
        <h3>
          작업에 사용자 확인이 필요합니다
          <span className="risk write">질문</span>
        </h3>
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>작업: {current.taskTitle}</div>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{current.question}</div>

        {current.options && current.options.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {current.options.map((opt, i) => (
              <button key={i} onClick={() => answer(opt)}>
                {opt}
              </button>
            ))}
          </div>
        )}

        <textarea
          autoFocus
          value={text}
          placeholder="직접 답변 입력 (Enter 전송, Shift+Enter 줄바꿈)"
          style={{ minHeight: 60, resize: 'vertical' }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              answer(text)
            }
          }}
        />
        <div className="actions">
          <button className="primary" onClick={() => answer(text)} disabled={!text.trim()}>
            답변 전송
          </button>
        </div>
      </div>
    </div>
  )
}

function mergeUnique(a: ClarifyRequest[], b: ClarifyRequest[]): ClarifyRequest[] {
  const seen = new Set(a.map((r) => r.requestId))
  return [...a, ...b.filter((r) => !seen.has(r.requestId))]
}
