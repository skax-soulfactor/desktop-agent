import { useEffect, useState } from 'react'
import type { MemoryEntry, MemoryType } from '@shared/types'
import Markdown from '../chat/Markdown'
import { NO_SHARE_TAG, TYPE_LABEL, relativeTime } from './useMemories'

interface Props {
  entry: MemoryEntry
  /** 출처 대화가 아직 남아 있는지 — 삭제됐으면 이동 버튼을 감춘다 */
  sourceExists: boolean
  onOpenSource: (sessionId: string) => void
  onSave: (patch: Partial<MemoryEntry>) => Promise<void>
  onDelete: () => Promise<void>
}

const LESSON_TEMPLATE = '**상황:** \n\n**실수:** \n\n**원인:** \n\n**재발 방지:** '

/**
 * 한 줄로 이어 붙여 저장된 옛 본문을 항목별로 끊어 읽히게 한다.
 * 표시 시점에만 적용하며 저장된 내용은 건드리지 않는다.
 */
function withSectionBreaks(text: string): string {
  if (text.includes('\n')) return text
  return text.replace(/\s*(\*\*[^*\n]{1,24}:\*\*)/g, (m, label: string, offset: number) =>
    offset === 0 ? m : `\n\n${label}`
  )
}

export default function MemoryDetail({
  entry,
  sourceExists,
  onOpenSource,
  onSave,
  onDelete
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [type, setType] = useState<MemoryType>(entry.type)
  const [title, setTitle] = useState(entry.title)
  const [content, setContent] = useState(entry.content)
  const [tagText, setTagText] = useState(entry.tags.join(', '))
  const [saving, setSaving] = useState(false)

  // 다른 기억을 선택하면 편집 상태를 버리고 새 값으로 초기화한다
  useEffect(() => {
    setEditing(false)
    setType(entry.type)
    setTitle(entry.title)
    setContent(entry.content)
    setTagText(entry.tags.join(', '))
  }, [entry.id])

  const noShare = entry.tags.includes(NO_SHARE_TAG)

  const save = async (): Promise<void> => {
    if (!title.trim()) return
    setSaving(true)
    await onSave({
      type,
      title: title.trim(),
      content,
      tags: tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    })
    setSaving(false)
    setEditing(false)
  }

  const toggleTag = async (tag: string): Promise<void> => {
    const next = entry.tags.includes(tag)
      ? entry.tags.filter((t) => t !== tag)
      : [...entry.tags, tag]
    await onSave({ tags: next })
  }

  if (editing) {
    return (
      <div className="mem-detail">
        <div className="mem-edit">
          <div className="row">
            <select value={type} onChange={(e) => setType(e.target.value as MemoryType)}>
              {(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <input
              className="mem-edit-title"
              value={title}
              placeholder="한 줄 요약"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <input
            value={tagText}
            placeholder="태그 (쉼표로 구분)"
            onChange={(e) => setTagText(e.target.value)}
          />
          <textarea
            className="mem-edit-body"
            value={content}
            placeholder="본문 (마크다운)"
            onChange={(e) => setContent(e.target.value)}
          />
          {type === 'lesson' && !content.includes('재발 방지') && (
            <div className="mem-hint">
              교훈에는 <strong>재발 방지</strong> 규칙이 있어야 같은 실수를 막을 수 있습니다.{' '}
              <button className="link" onClick={() => setContent(content || LESSON_TEMPLATE)}>
                형식 넣기
              </button>
            </div>
          )}
          <div className="row">
            <button className="primary" disabled={saving || !title.trim()} onClick={() => void save()}>
              저장
            </button>
            <button onClick={() => setEditing(false)}>취소</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mem-detail">
      <div className="mem-detail-head">
        <div className="row">
          <span className={`tag ${entry.type}`}>{TYPE_LABEL[entry.type]}</span>
          {entry.status === 'archived' && <span className="tag">보관됨</span>}
          {entry.origin === 'user' && <span className="tag">직접 작성</span>}
          <h3 className="mem-detail-title">{entry.title}</h3>
        </div>
        <div className="mem-detail-toggles">
          <button
            className={`mem-toggle ${entry.pinned ? 'on' : ''}`}
            title="고정하면 검색 순위와 무관하게 본문이 매 턴 항상 주입됩니다"
            onClick={() => void onSave({ pinned: !entry.pinned })}
          >
            📌 고정
          </button>
          <button
            className={`mem-toggle ${noShare ? 'on' : ''}`}
            title="켜면 다른 에이전트(피어)의 질문에 답할 때 이 기억을 사용하지 않습니다"
            onClick={() => void toggleTag(NO_SHARE_TAG)}
          >
            🔒 공유 제외
          </button>
        </div>
      </div>

      {entry.tags.filter((t) => t !== NO_SHARE_TAG).length > 0 && (
        <div className="mem-detail-tags">
          {entry.tags
            .filter((t) => t !== NO_SHARE_TAG)
            .map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
        </div>
      )}

      <div className="mem-detail-body">
        <Markdown text={withSectionBreaks(entry.content)} />
      </div>

      <div className="mem-detail-meta">
        <span>생성 {new Date(entry.createdAt).toLocaleDateString()}</span>
        <span>갱신 {new Date(entry.updatedAt).toLocaleDateString()}</span>
        <span>
          회상 {entry.recallCount ?? 0}회
          {(entry.recallCount ?? 0) > 0 && ` · ${relativeTime(entry.lastRecalledAt)}`}
        </span>
        {entry.sourceSessionId ? (
          sourceExists ? (
            <button className="link" onClick={() => onOpenSource(entry.sourceSessionId)}>
              출처 대화 열기 ↗
            </button>
          ) : (
            <span className="mem-orphan">출처 대화 삭제됨</span>
          )
        ) : null}
      </div>

      <div className="row">
        <button onClick={() => setEditing(true)}>편집</button>
        <button
          onClick={() =>
            void onSave({ status: entry.status === 'archived' ? 'active' : 'archived' })
          }
        >
          {entry.status === 'archived' ? '복구' : '보관'}
        </button>
        <button className="danger" onClick={() => void onDelete()}>
          삭제
        </button>
      </div>
    </div>
  )
}
