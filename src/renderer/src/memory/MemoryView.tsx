import { useEffect, useMemo, useState } from 'react'
import type { MemoryEntry, MemoryType } from '@shared/types'
import MemoryStatsStrip, { type TypeFilter } from './MemoryStats'
import MemoryList, { SORT_LABEL, type SortKey } from './MemoryList'
import MemoryDetail from './MemoryDetail'
import MemoryReview from './MemoryReview'
import MemoryCompose from './MemoryCompose'
import MemoryPreview from './MemoryPreview'
import { TYPE_LABEL, useMemories } from './useMemories'

interface Props {
  /** 채팅의 기억 카드에서 넘어온 경우 해당 항목을 선택 상태로 연다 */
  focusId?: string | null
  /** 출처 대화 열기 — App이 대화 탭으로 전환한다 */
  onOpenSession: (sessionId: string) => void
}

const TYPE_ORDER: MemoryType[] = ['user', 'requirement', 'lesson', 'reference']

function sortEntries(entries: MemoryEntry[], key: SortKey): MemoryEntry[] {
  const byTime = (v?: string): number => (v ? new Date(v).getTime() : 0)
  return [...entries].sort((a, b) => {
    if (key === 'updated') return byTime(b.updatedAt) - byTime(a.updatedAt)
    if (key === 'created') return byTime(a.createdAt) - byTime(b.createdAt)
    if (key === 'recalled') return byTime(b.lastRecalledAt) - byTime(a.lastRecalledAt)
    if (key === 'unused') {
      const d = (a.recallCount ?? 0) - (b.recallCount ?? 0)
      // 회상 횟수가 같으면 마지막으로 쓰인 지 오래된 것을 먼저
      return d !== 0 ? d : byTime(a.lastRecalledAt ?? a.createdAt) - byTime(b.lastRecalledAt ?? b.createdAt)
    }
    const t = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
    return t !== 0 ? t : a.title.localeCompare(b.title)
  })
}

export default function MemoryView({ focusId, onOpenSession }: Props): JSX.Element {
  const { entries, stats, review, loading, refresh } = useMemories()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TypeFilter>('all')
  /** 보관함 보기 — 활성 목록과 섞지 않고 따로 본다 */
  const [showArchived, setShowArchived] = useState(false)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [sort, setSort] = useState<SortKey>('updated')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [reviewOpen, setReviewOpen] = useState(false)
  const [composing, setComposing] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [sessionIds, setSessionIds] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listSessions().then((list) => setSessionIds(new Set(list.map((s) => s.id))))
  }, [])

  // 채팅 카드에서 넘어온 항목으로 이동 — 필터에 가려지지 않도록 조건을 푼다
  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    setQuery('')
    setFilter('all')
    setActiveTags([])
    setComposing(false)
    const target = entries.find((m) => m.id === focusId)
    if (target) setShowArchived(target.status === 'archived')
  }, [focusId, entries])

  const flash = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const scoped = useMemo(
    () => entries.filter((m) => (showArchived ? m.status === 'archived' : m.status === 'active')),
    [entries, showArchived]
  )

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of scoped) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [scoped])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = scoped.filter((m) => {
      if (filter !== 'all' && m.type !== filter) return false
      if (activeTags.length > 0 && !activeTags.every((t) => m.tags.includes(t))) return false
      if (!q) return true
      return (
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
    return sortEntries(list, sort)
  }, [scoped, filter, activeTags, query, sort])

  const selected = entries.find((m) => m.id === selectedId) ?? null

  const toggleCheck = (id: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = (): void =>
    setChecked((prev) =>
      filtered.every((m) => prev.has(m.id)) ? new Set() : new Set(filtered.map((m) => m.id))
    )

  const afterMutation = async (msg?: string): Promise<void> => {
    await refresh()
    setChecked(new Set())
    if (msg) flash(msg)
  }

  const bulk = async (action: 'archive' | 'activate' | 'delete'): Promise<void> => {
    const ids = [...checked]
    if (ids.length === 0) return
    if (action === 'delete' && !confirm(`선택한 ${ids.length}건을 삭제할까요? 되돌릴 수 없습니다.`))
      return
    const n = await window.api.bulkMemory(ids, action)
    if (ids.includes(selectedId ?? '') && action === 'delete') setSelectedId(null)
    const label = action === 'delete' ? '삭제' : action === 'archive' ? '보관' : '복구'
    await afterMutation(`${n}건 ${label}했습니다.`)
  }

  const bulkTag = async (): Promise<void> => {
    const ids = [...checked]
    if (ids.length === 0) return
    const tag = prompt('추가할 태그')?.trim()
    if (!tag) return
    const n = await window.api.bulkMemory(ids, 'addTag', tag)
    await afterMutation(`${n}건에 #${tag} 태그를 추가했습니다.`)
  }

  const saveSelected = async (patch: Partial<MemoryEntry>): Promise<void> => {
    if (!selectedId) return
    await window.api.updateMemory(selectedId, patch)
    await refresh()
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selectedId || !selected) return
    if (!confirm(`"${selected.title}"을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return
    await window.api.deleteMemory(selectedId)
    setSelectedId(null)
    await afterMutation('삭제했습니다.')
  }

  const doExport = async (format: 'json' | 'md'): Promise<void> => {
    const path = await window.api.exportMemories(format)
    if (path) flash(`내보냈습니다: ${path}`)
  }

  const doImport = async (): Promise<void> => {
    const r = await window.api.importMemories()
    if (!r) return
    await refresh()
    flash(r.error ? `가져오기 실패: ${r.error}` : `${r.added}건 추가, ${r.skipped}건 건너뜀`)
  }

  return (
    <div className="page mem-page">
      <div className="mem-header">
        <h2>지식베이스</h2>
        <div className="row">
          <button className="primary" onClick={() => { setComposing(true); setSelectedId(null) }}>
            + 기억 추가
          </button>
          <button onClick={() => void doExport('json')}>내보내기 (JSON)</button>
          <button onClick={() => void doExport('md')}>내보내기 (MD)</button>
          <button onClick={() => void doImport()}>가져오기</button>
        </div>
      </div>

      <MemoryStatsStrip
        stats={stats}
        filter={filter}
        onFilter={(f) => {
          setFilter(f)
          setShowArchived(false)
        }}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        reviewCount={review.length}
        reviewOpen={reviewOpen}
        onToggleReview={() => setReviewOpen((v) => !v)}
        onPreview={() => setPreviewOpen(true)}
      />

      {reviewOpen && review.length > 0 && (
        <MemoryReview
          items={review}
          onSelect={(id) => {
            setSelectedId(id)
            setComposing(false)
          }}
          onMerge={async (keepId, dropId) => {
            await window.api.mergeMemories(keepId, [dropId])
            setSelectedId(keepId)
            await afterMutation('병합했습니다. 유지본 내용을 확인하세요.')
          }}
          onArchive={async (id) => {
            await window.api.updateMemory(id, { status: 'archived' })
            await afterMutation('보관했습니다.')
          }}
          onReviewed={async (id) => {
            await window.api.markMemoryReviewed(id)
            await refresh()
          }}
        />
      )}

      {loading ? (
        <div className="empty">불러오는 중…</div>
      ) : entries.length === 0 ? (
        <div className="empty">
          아직 기억이 없습니다. 에이전트와 협업하면 요구사항과 교훈이 자동으로 축적됩니다.
        </div>
      ) : (
        <div className="mem-workbench">
          <div className="mem-pane-left">
            <div className="mem-toolbar">
              <input
                className="mem-search"
                value={query}
                placeholder="제목·본문·태그 검색"
                onChange={(e) => setQuery(e.target.value)}
              />
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>

            {tagCounts.length > 0 && (
              <div className="mem-tagcloud">
                {tagCounts.slice(0, 14).map(([t, n]) => (
                  <button
                    key={t}
                    className={`mem-tagchip ${activeTags.includes(t) ? 'on' : ''}`}
                    onClick={() =>
                      setActiveTags((prev) =>
                        prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
                      )
                    }
                  >
                    #{t} <span className="n">{n}</span>
                  </button>
                ))}
                {activeTags.length > 0 && (
                  <button className="link" onClick={() => setActiveTags([])}>
                    태그 해제
                  </button>
                )}
              </div>
            )}

            <MemoryList
              entries={filtered}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id)
                setComposing(false)
              }}
              checked={checked}
              onToggleCheck={toggleCheck}
              onToggleAll={toggleAll}
              query={query}
            />

            {checked.size > 0 && (
              <div className="mem-bulkbar">
                <span>{checked.size}건 선택</span>
                {showArchived ? (
                  <button onClick={() => void bulk('activate')}>복구</button>
                ) : (
                  <button onClick={() => void bulk('archive')}>보관</button>
                )}
                <button onClick={() => void bulkTag()}>태그 추가</button>
                <button className="danger" onClick={() => void bulk('delete')}>
                  삭제
                </button>
                <button className="link" onClick={() => setChecked(new Set())}>
                  해제
                </button>
              </div>
            )}
          </div>

          <div className="mem-pane-right">
            {composing ? (
              <MemoryCompose
                onCancel={() => setComposing(false)}
                onCreate={async (data) => {
                  const created = await window.api.createMemory(data)
                  setComposing(false)
                  setSelectedId(created.id)
                  await afterMutation('추가했습니다.')
                }}
              />
            ) : selected ? (
              <MemoryDetail
                entry={selected}
                sourceExists={sessionIds.has(selected.sourceSessionId)}
                onOpenSource={onOpenSession}
                onSave={saveSelected}
                onDelete={deleteSelected}
              />
            ) : (
              <div className="mem-detail-empty">
                왼쪽에서 기억을 선택하면 전문을 보고 바로 고칠 수 있습니다.
                <div className="mem-detail-empty-sub">
                  타입: {TYPE_ORDER.map((t) => TYPE_LABEL[t]).join(' · ')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {previewOpen && <MemoryPreview onClose={() => setPreviewOpen(false)} />}
      {toast && <div className="mem-toast">{toast}</div>}
    </div>
  )
}
