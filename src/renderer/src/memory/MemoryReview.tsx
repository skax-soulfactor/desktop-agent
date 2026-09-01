import type { MemoryReviewItem, MemoryReviewKind } from '@shared/types'
import { TYPE_LABEL } from './useMemories'

const KIND_LABEL: Record<MemoryReviewKind, string> = {
  duplicate: '중복 의심',
  stale: '노후',
  malformed: '형식 불일치',
  orphan: '출처 유실',
  unverified: '확인 안 됨'
}

interface Props {
  items: MemoryReviewItem[]
  onSelect: (id: string) => void
  onMerge: (keepId: string, dropId: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
  onReviewed: (id: string) => Promise<void>
}

/**
 * 점검 대기함.
 * 자동 축적의 진짜 문제는 "많아서 안 보인다"가 아니라
 * "틀린 게 섞여 있는데 어느 게 틀렸는지 모른다"는 것이다.
 */
export default function MemoryReview({
  items,
  onSelect,
  onMerge,
  onArchive,
  onReviewed
}: Props): JSX.Element {
  return (
    <div className="mem-review">
      <div className="mem-review-head">
        점검이 필요한 기억 {items.length}건 — 자동으로 쌓인 기억 중 확인이 필요한 것들입니다.
      </div>
      {items.map((it, i) => (
        <div key={`${it.kind}-${it.id}-${i}`} className="mem-review-item">
          <div className="mem-review-main">
            <span className={`mem-review-kind ${it.kind}`}>{KIND_LABEL[it.kind]}</span>
            <button className="link mem-review-title" onClick={() => onSelect(it.id)}>
              <span className={`tag ${it.type}`}>{TYPE_LABEL[it.type]}</span>
              {it.title}
            </button>
          </div>
          <div className="mem-review-reason">{it.reason}</div>
          {it.pairTitle && (
            <div className="mem-review-pair">
              짝:{' '}
              <button className="link" onClick={() => it.pairId && onSelect(it.pairId)}>
                {it.pairTitle}
              </button>
            </div>
          )}
          <div className="row">
            {it.kind === 'duplicate' && it.pairId && (
              <>
                <button onClick={() => void onMerge(it.id, it.pairId as string)}>
                  이쪽으로 병합
                </button>
                <button onClick={() => void onMerge(it.pairId as string, it.id)}>
                  짝으로 병합
                </button>
              </>
            )}
            {it.kind === 'stale' && <button onClick={() => void onArchive(it.id)}>보관</button>}
            {it.kind === 'malformed' && (
              <button onClick={() => onSelect(it.id)}>편집하러 가기</button>
            )}
            {it.kind === 'unverified' && (
              <>
                <button onClick={() => onSelect(it.id)}>내용 확인</button>
                <button onClick={() => void onArchive(it.id)}>보관</button>
              </>
            )}
            <button className="link" onClick={() => void onReviewed(it.id)}>
              확인함
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
