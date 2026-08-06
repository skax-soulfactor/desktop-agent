import { useEffect, useState } from 'react'

interface Props {
  onClose: () => void
}

/**
 * 주입 미리보기 — "이 질문을 보내면 프롬프트에 실제로 이게 들어갑니다".
 * 에이전트가 왜 그렇게 답했는지를 사용자가 직접 확인할 수 있는 유일한 창구다.
 * 회상 이력을 남기지 않는 dryRun 경로를 쓴다.
 */
export default function MemoryPreview({ onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ text: string; tokens: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.memoryPreview(query).then((r) => {
        if (!cancelled) setResult(r)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog mem-preview" onClick={(e) => e.stopPropagation()}>
        <h3>컨텍스트 주입 미리보기</h3>
        <p className="mem-preview-hint">
          아래 질문을 보냈을 때 프롬프트 앞에 실제로 붙는 지식베이스 블록입니다. 질문을 비워 두면
          검색과 무관하게 <strong>매 턴 항상</strong> 들어가는 부분만 보입니다.
        </p>
        <input
          autoFocus
          value={query}
          placeholder="예: 배포 스크립트 고쳐줘"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mem-preview-meta">
          {result ? `${result.tokens.toLocaleString()} 토큰 · ${result.text.length.toLocaleString()}자` : '계산 중…'}
        </div>
        <pre className="mem-preview-body">{result?.text || '(주입할 기억이 없습니다)'}</pre>
        <div className="actions">
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}
