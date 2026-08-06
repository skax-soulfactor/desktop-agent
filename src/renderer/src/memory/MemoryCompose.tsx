import { useState } from 'react'
import type { MemoryEntry, MemoryType } from '@shared/types'
import { TYPE_LABEL } from './useMemories'

type Draft = Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags'>

interface Props {
  onCreate: (data: Draft) => Promise<void>
  onCancel: () => void
}

const LESSON_TEMPLATE = '**상황:** \n\n**실수:** \n\n**원인:** \n\n**재발 방지:** '

/** 사용자가 규칙을 직접 넣는 경로 — 대화에서 "기억해줘"를 거치지 않는 가장 확실한 통제 수단 */
export default function MemoryCompose({ onCreate, onCancel }: Props): JSX.Element {
  const [type, setType] = useState<MemoryType>('requirement')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)

  const pickType = (t: MemoryType): void => {
    setType(t)
    if (t === 'lesson' && !content.trim()) setContent(LESSON_TEMPLATE)
  }

  const submit = async (): Promise<void> => {
    if (!title.trim() || saving) return
    setSaving(true)
    await onCreate({
      type,
      title: title.trim(),
      content,
      tags: tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    })
    setSaving(false)
  }

  return (
    <div className="mem-detail">
      <h3 className="mem-detail-title">새 기억</h3>
      <div className="mem-edit">
        <div className="row">
          <select value={type} onChange={(e) => pickType(e.target.value as MemoryType)}>
            {(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            className="mem-edit-title"
            value={title}
            placeholder="한 줄 요약 — 이 문장이 매 턴 인덱스에 들어갑니다"
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
        <div className="row">
          <button className="primary" disabled={!title.trim() || saving} onClick={() => void submit()}>
            추가
          </button>
          <button onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>
  )
}
