import type { MemoryEntry } from '@shared/types'
import { estimateTokens } from '../llm/profile'
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
  /**
   * 이 블록에 허용된 토큰. 로컬 모델처럼 창이 좁을 때 지식베이스가 시스템 프롬프트를
   * 밀어내지 않도록, 인덱스 길이·본문 길이·주입 개수를 예산 안에서 줄인다.
   */
  budgetTokens?: number
}

/** 예산이 없을 때(클라우드)의 기본값 */
const FULL_BODY_CHARS = 1500
const FULL_RELEVANT = 5

/**
 * 회상: (1) 전체 기억의 한 줄 인덱스, (2) 고정 기억 전문, (3) 현재 메시지와 관련된 기억 전문 top-k 주입.
 * 토큰 예산을 넘지 않도록 개수와 본문 길이를 제한한다.
 */
export function buildMemoryContext(userMessage: string, opts: RecallOptions = {}): string {
  const { shareableOnly = false, dryRun = false, budgetTokens } = opts
  const shareable = (m: MemoryEntry): boolean => !shareableOnly || !m.tags.includes(NO_SHARE_TAG)

  const all = listMemories().filter(shareable)
  if (all.length === 0) return ''

  // 예산이 주어지면 본문은 예산의 1/5, 인덱스는 1/4을 넘지 않게 잡는다.
  // 관련 기억 개수도 함께 줄여야 개수 × 본문이 다시 예산을 넘지 않는다.
  const bodyChars = budgetTokens
    ? Math.max(200, Math.min(FULL_BODY_CHARS, Math.round((budgetTokens / 5) * 1.6)))
    : FULL_BODY_CHARS
  const topK = budgetTokens ? Math.max(1, Math.min(FULL_RELEVANT, Math.floor(budgetTokens / 250))) : FULL_RELEVANT
  const indexBudget = budgetTokens ? Math.round(budgetTokens / 4) : Number.POSITIVE_INFINITY

  const indexLines: string[] = []
  let indexTokens = 0
  let omitted = 0
  // 예산을 넘기는 항목은 건너뛰고 개수만 남긴다 — 목록이 통째로 사라지는 것보다,
  // 무엇이 더 있는지 모델이 아는 편이 낫다
  for (const m of all) {
    const line = `- [${TYPE_LABEL[m.type]}] ${m.title}`
    const cost = estimateTokens(line)
    if (indexTokens + cost > indexBudget) {
      omitted++
      continue
    }
    indexTokens += cost
    indexLines.push(line)
  }
  if (omitted > 0) indexLines.push(`- ...(${omitted}건 생략 — 지식베이스 탭에서 전체 확인)`)

  const pinned = pinnedMemories().filter(shareable)
  const search = dryRun ? queryMemories : recallMemories
  const relevant = search(userMessage, topK).filter(
    (m) => shareable(m) && !pinned.some((p) => p.id === m.id)
  )

  // 기록 시점을 함께 보여준다 — 기억에 적힌 버전·경로·설정값은 적을 당시의 것이라 낡을 수 있고,
  // 모델이 그것을 다시 확인할지 판단하려면 언제 적힌 것인지 알아야 한다.
  // 도구로 아무것도 확인하지 않은 턴에서 나온 것은 그 사실도 함께 붙인다 — 표시가 없으면
  // 에이전트가 지어낸 말이 다음 턴에서 "지식베이스에 있는 것"으로 승격된다.
  const mark = (m: MemoryEntry): string =>
    `(기록: ${m.updatedAt.slice(0, 10)}${m.unverified ? ', 확인 안 됨' : ''})`
  const body = (m: MemoryEntry): string =>
    `### [${TYPE_LABEL[m.type]}] ${m.title} ${mark(m)}\n${m.content.slice(0, bodyChars)}`

  let ctx = `## 지식베이스 (이전 협업에서 기록된 기억)\n\n### 전체 기억 인덱스\n${indexLines.join('\n')}`
  if (pinned.length > 0) {
    ctx += `\n\n### 항상 지켜야 할 고정 기억\n\n${pinned.map(body).join('\n\n')}`
  }
  if (relevant.length > 0) {
    ctx += `\n\n### 현재 요청과 관련된 기억\n\n${relevant.map(body).join('\n\n')}`
  }
  ctx += budgetTokens
    ? '\n\n기억은 배경 참고일 뿐 검증된 사실이 아니다. 현재 발언과 직접 확인한 것을 우선하라. ' +
      '"확인 안 됨"이 붙은 기억은 에이전트가 확인 없이 말했던 내용이다. 그것을 출처로 적지 말고, 사실로 답해야 하면 지금 다시 확인하라.'
    : '\n\n기억을 활용해 사용자의 의도를 파악하고, 관련된 진행 중 작업이나 요구사항이 있으면 선제적으로 제안하라. ' +
      '교훈(lesson) 기억이 있으면 같은 실수를 반복하지 마라. 기억이 사용자의 현재 발언과 모순되면 현재 발언을 우선하라. ' +
      '기억은 배경 참고일 뿐 검증된 사실이 아니다. 지금 직접 확인한 것보다 앞세우지 말고, 기억 내용을 이번에 확인한 결과인 것처럼 말하지 마라. ' +
      '기억을 근거로 답한 부분은 그 기억의 제목을 출처로 밝혀라. ' +
      '단 "확인 안 됨"이 붙은 기억은 예외다 — 그것은 에이전트가 도구로 아무것도 확인하지 않은 턴에서 한 말이 그대로 남은 것이라, 출처가 아니라 아직 검증되지 않은 주장이다. ' +
      '출처로 적지 말고, 그 내용을 사실로 답해야 하면 지금 직접 확인한 뒤 답하라.'
  return ctx
}
