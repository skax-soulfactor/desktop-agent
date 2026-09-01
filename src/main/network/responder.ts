import { stepCountIs } from 'ai'
import { completeText } from '../llm/complete'
import { estimateTokens } from '../llm/profile'
import { resolveModelFor } from '../llm/providers'
import { buildMemoryContext } from '../memory/recall'
import { recordUsage } from '../usage/store'

const RESPONDER_PROMPT = `너는 다른 사용자의 에이전트로부터 온 질문에 답하는 응답 에이전트다.
너의 사용자의 지식베이스(공유 가능 항목만)를 근거로 도움이 되는 답변을 제공하라.

엄격한 규칙:
- 사용자의 개인정보, 자격증명(비밀번호·토큰·키), 회사 내부 경로·URL, 민감한 세부사항은 절대 답변에 포함하지 마라.
- 능력·지식·방법론만 공유하라. 확실하지 않으면 모른다고 답하라.
- 질문과 무관한 내부 정보를 흘리지 마라.
- 간결하고 실용적으로 답하라.
- 답변의 각 부분이 너의 사용자가 기록해 둔 경험에 근거한 것인지 너의 일반 지식인지 구분해 밝혀라. 다만 기억 제목·파일 경로·내부 URL 같은 식별 정보는 출처로 적지 마라.`

/** 피어의 question 요청에 대해 지식베이스로 답변을 생성한다 (도구 없음, 공유 제외 기억 배제) */
export async function answerQuestion(question: string): Promise<string> {
  const { model, config, profile } = await resolveModelFor('standard')
  const memoryBudget = profile.local
    ? Math.max(0, Math.floor((profile.promptBudget - estimateTokens(RESPONDER_PROMPT + question)) * 0.6))
    : undefined
  const memoryContext = buildMemoryContext(question, {
    shareableOnly: true,
    budgetTokens: memoryBudget
  })
  const system = memoryContext ? `${RESPONDER_PROMPT}\n\n${memoryContext}` : RESPONDER_PROMPT
  const { text, usage } = await completeText({
    model,
    system,
    prompt: question,
    stopWhen: stepCountIs(1),
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {})
  })
  recordUsage({ kind: 'network', provider: config.label, model: config.model, tier: 'standard' }, usage)
  return text.trim() || '답변을 생성하지 못했습니다.'
}
