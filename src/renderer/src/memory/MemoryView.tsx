import { useEffect, useState } from 'react'
import type { MemoryEntry, MemoryType } from '@shared/types'

const TYPE_LABEL: Record<MemoryType, string> = {
  user: '사용자',
  requirement: '요구사항',
  lesson: '교훈',
  reference: '참조'
}

export default function MemoryView(): JSX.Element {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [filter, setFilter] = useState<MemoryType | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setMemories(await window.api.listMemories())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const filtered = memories.filter((m) => filter === 'all' || m.type === filter)

  return (
    <div className="page">
      <h2>지식베이스</h2>
      <div className="row">
        <button className={filter === 'all' ? 'primary' : ''} onClick={() => setFilter('all')}>
          전체 ({memories.length})
        </button>
        {(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => (
          <button key={t} className={filter === t ? 'primary' : ''} onClick={() => setFilter(t)}>
            {TYPE_LABEL[t]} ({memories.filter((m) => m.type === t).length})
          </button>
        ))}
      </div>
      {filtered.length === 0 && (
        <div className="empty">
          아직 기억이 없습니다. 에이전트와 협업하면 요구사항과 교훈이 자동으로 축적됩니다.
        </div>
      )}
      {filtered.map((m) => (
        <div key={m.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span className={`tag ${m.type}`}>{TYPE_LABEL[m.type]}</span>
              {m.status === 'archived' && <span className="tag">보관됨</span>}
              <strong style={{ marginLeft: 6 }}>{m.title}</strong>
            </div>
            <div className="row">
              <button onClick={() => setOpen(open === m.id ? null : m.id)}>
                {open === m.id ? '접기' : '펼치기'}
              </button>
              <button className="danger" onClick={() => void window.api.deleteMemory(m.id).then(refresh)}>
                삭제
              </button>
            </div>
          </div>
          {open === m.id && (
            <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>
              {m.content}
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {m.tags.map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
                <span style={{ marginLeft: 8 }}>
                  생성 {new Date(m.createdAt).toLocaleDateString()} · 갱신{' '}
                  {new Date(m.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
