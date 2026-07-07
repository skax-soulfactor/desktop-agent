import { listMemories, searchMemories } from './store'

const TYPE_LABEL: Record<string, string> = {
  user: '사용자',
  requirement: '요구사항',
  lesson: '교훈',
  reference: '참조'
}

const NO_SHARE_TAG = '공유제외'

/**
 * 회상: (1) 전체 기억의 한 줄 인덱스는 항상 포함, (2) 현재 메시지와 관련된 기억 전문 top-k 주입.
 * 토큰 예산을 넘지 않도록 본문 길이를 제한한다.
 * shareableOnly=true면 원격(피어) 응답용으로 '공유제외' 태그 기억을 배제한다.
 */
export function buildMemoryContext(userMessage: string, shareableOnly = false): string {
  const all = listMemories().filter((m) => !shareableOnly || !m.tags.includes(NO_SHARE_TAG))
  if (all.length === 0) return ''

  const index = all.map((m) => `- [${TYPE_LABEL[m.type]}] ${m.title}`).join('\n')

  const relevant = searchMemories(userMessage, 5).filter(
    (m) => !shareableOnly || !m.tags.includes(NO_SHARE_TAG)
  )
  const bodies = relevant
    .map((m) => `### [${TYPE_LABEL[m.type]}] ${m.title}\n${m.content.slice(0, 1500)}`)
    .join('\n\n')

  let ctx = `## 지식베이스 (이전 협업에서 기록된 기억)\n\n### 전체 기억 인덱스\n${index}`
  if (bodies) {
    ctx += `\n\n### 현재 요청과 관련된 기억\n\n${bodies}`
  }
  ctx +=
    '\n\n기억을 활용해 사용자의 의도를 파악하고, 관련된 진행 중 작업이나 요구사항이 있으면 선제적으로 제안하라. ' +
    '교훈(lesson) 기억이 있으면 같은 실수를 반복하지 마라. 기억이 사용자의 현재 발언과 모순되면 현재 발언을 우선하라.'
  return ctx
}
