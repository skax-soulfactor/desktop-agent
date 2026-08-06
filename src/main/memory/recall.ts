import type { MemoryEntry } from '@shared/types'
import { listMemories, pinnedMemories, queryMemories, recallMemories } from './store'

const TYPE_LABEL: Record<string, string> = {
  user: '사용자',
  requirement: '요구사항',
  lesson: '교훈',
  reference: '참조'
}

const NO_SHARE_TAG = '공유제외'

export interface RecallOptions {
  /** 원격(피어) 응답용 — '공유제외' 태그 기억을 배제한다 */
  shareableOnly?: boolean
  /**
   * true면 회상 이력(lastRecalledAt, recallCount)을 남기지 않는다.
   * 지식베이스의 "주입 미리보기"처럼 실제 주입이 아닌 경로에서 사용한다.
   */
  dryRun?: boolean
}

/**
 * 회상: (1) 전체 기억의 한 줄 인덱스는 항상 포함, (2) 고정 기억 전문, (3) 현재 메시지와 관련된 기억 전문 top-k 주입.
 * 토큰 예산을 넘지 않도록 본문 길이를 제한한다.
 */
export function buildMemoryContext(userMessage: string, opts: RecallOptions = {}): string {
  const { shareableOnly = false, dryRun = false } = opts
  const shareable = (m: MemoryEntry): boolean => !shareableOnly || !m.tags.includes(NO_SHARE_TAG)

  const all = listMemories().filter(shareable)
  if (all.length === 0) return ''

  const index = all.map((m) => `- [${TYPE_LABEL[m.type]}] ${m.title}`).join('\n')

  const pinned = pinnedMemories().filter(shareable)
  const search = dryRun ? queryMemories : recallMemories
  const relevant = search(userMessage, 5).filter(
    (m) => shareable(m) && !pinned.some((p) => p.id === m.id)
  )

  const body = (m: MemoryEntry): string =>
    `### [${TYPE_LABEL[m.type]}] ${m.title}\n${m.content.slice(0, 1500)}`

  let ctx = `## 지식베이스 (이전 협업에서 기록된 기억)\n\n### 전체 기억 인덱스\n${index}`
  if (pinned.length > 0) {
    ctx += `\n\n### 항상 지켜야 할 고정 기억\n\n${pinned.map(body).join('\n\n')}`
  }
  if (relevant.length > 0) {
    ctx += `\n\n### 현재 요청과 관련된 기억\n\n${relevant.map(body).join('\n\n')}`
  }
  ctx +=
    '\n\n기억을 활용해 사용자의 의도를 파악하고, 관련된 진행 중 작업이나 요구사항이 있으면 선제적으로 제안하라. ' +
    '교훈(lesson) 기억이 있으면 같은 실수를 반복하지 마라. 기억이 사용자의 현재 발언과 모순되면 현재 발언을 우선하라. ' +
    '기억은 배경 참고일 뿐 검증된 사실이 아니다. 지금 직접 확인한 것보다 앞세우지 말고, 기억 내용을 이번에 확인한 결과인 것처럼 말하지 마라.'
  return ctx
}
