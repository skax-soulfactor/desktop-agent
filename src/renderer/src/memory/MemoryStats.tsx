import type { MemoryStats, MemoryType } from '@shared/types'
import { TYPE_LABEL } from './useMemories'

export type TypeFilter = MemoryType | 'all'

interface Props {
  stats: MemoryStats | null
  filter: TypeFilter
  onFilter: (f: TypeFilter) => void
  showArchived: boolean
  onToggleArchived: () => void
  reviewCount: number
  reviewOpen: boolean
  onToggleReview: () => void
  onPreview: () => void
}

/**
 * 상단 요약 스트립.
 * 보관본을 활성 카운트에서 분리해 보여주고, 매 턴 주입 비용을 처음으로 노출한다.
 */
export default function MemoryStatsStrip({
  stats,
  filter,
  onFilter,
  showArchived,
  onToggleArchived,
  reviewCount,
  reviewOpen,
  onToggleReview,
  onPreview
}: Props): JSX.Element {
  const tiles: { key: TypeFilter | 'archived'; label: string; value: number }[] = [
    { key: 'all', label: '전체', value: stats?.total ?? 0 },
    ...(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => ({
      key: t as TypeFilter,
      label: TYPE_LABEL[t],
      value: stats?.byType[t] ?? 0
    })),
    { key: 'archived' as const, label: '보관', value: stats?.archived ?? 0 }
  ]

  return (
    <div className="mem-summary">
      <div className="mem-tiles">
        {tiles.map((t) => {
          const active = t.key === 'archived' ? showArchived : filter === t.key && !showArchived
          return (
            <button
              key={t.key}
              className={`mem-tile ${active ? 'active' : ''} ${t.key === 'archived' ? 'muted' : ''}`}
              onClick={() => (t.key === 'archived' ? onToggleArchived() : onFilter(t.key))}
            >
              <span className="mem-tile-label">{t.label}</span>
              <span className="mem-tile-value">{t.value}</span>
            </button>
          )
        })}
      </div>
      <div className="mem-summary-meta">
        {reviewCount > 0 ? (
          <button className={`mem-review-badge ${reviewOpen ? 'active' : ''}`} onClick={onToggleReview}>
            ⚠ 점검 필요 {reviewCount}건
          </button>
        ) : (
          <span className="mem-clean">✓ 점검할 항목 없음</span>
        )}
        {stats && (
          <button
            className="mem-inject"
            onClick={onPreview}
            title="검색과 무관하게 매 턴 프롬프트에 항상 들어가는 지식베이스 블록의 크기입니다. 클릭하면 실제 내용을 봅니다."
          >
            매 턴 주입량 ≈ {stats.injectedTokens.toLocaleString()} 토큰
            {stats.pinned > 0 && ` · 고정 ${stats.pinned}`}
          </button>
        )}
      </div>
    </div>
  )
}
