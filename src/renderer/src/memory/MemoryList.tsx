import type { MemoryEntry } from '@shared/types'
import { TYPE_LABEL, relativeTime } from './useMemories'

export type SortKey = 'updated' | 'recalled' | 'unused' | 'created' | 'type'

export const SORT_LABEL: Record<SortKey, string> = {
  updated: '최근 갱신순',
  recalled: '최근 회상순',
  unused: '안 쓰인 순',
  created: '오래된 순',
  type: '타입별'
}

interface Props {
  entries: MemoryEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  checked: Set<string>
  onToggleCheck: (id: string) => void
  onToggleAll: () => void
  query: string
}

/** 검색어와 겹치는 부분을 <mark>로 감싼다 (대화 검색 결과와 같은 스타일) */
function highlight(text: string, query: string): JSX.Element {
  const q = query.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

export default function MemoryList({
  entries,
  selectedId,
  onSelect,
  checked,
  onToggleCheck,
  onToggleAll,
  query
}: Props): JSX.Element {
  const allChecked = entries.length > 0 && entries.every((m) => checked.has(m.id))

  return (
    <div className="mem-list">
      <div className="mem-list-head">
        <label className="mem-check">
          <input type="checkbox" checked={allChecked} onChange={onToggleAll} />
        </label>
        <span className="mem-list-count">{entries.length}건</span>
      </div>
      {entries.length === 0 && <div className="mem-list-empty">조건에 맞는 기억이 없습니다.</div>}
      {entries.map((m) => (
        <div
          key={m.id}
          className={`mem-row ${selectedId === m.id ? 'active' : ''}`}
          onClick={() => onSelect(m.id)}
        >
          <label className="mem-check" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={checked.has(m.id)}
              onChange={() => onToggleCheck(m.id)}
            />
          </label>
          <span className={`tag ${m.type}`}>{TYPE_LABEL[m.type]}</span>
          <span className="mem-row-title">
            {m.pinned && <span className="mem-pin" title="고정 — 항상 주입됨">📌</span>}
            {highlight(m.title, query)}
          </span>
          {m.status === 'archived' && <span className="mem-row-flag">보관</span>}
          <span
            className={`mem-row-when ${(m.recallCount ?? 0) === 0 ? 'never' : ''}`}
            title={
              (m.recallCount ?? 0) === 0
                ? '저장 후 한 번도 회상되지 않았습니다'
                : `회상 ${m.recallCount}회`
            }
          >
            {relativeTime(m.lastRecalledAt)}
          </span>
        </div>
      ))}
    </div>
  )
}
