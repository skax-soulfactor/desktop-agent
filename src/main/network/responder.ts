import { generateText, stepCountIs } from 'ai'
import { getModelFor } from '../llm/providers'
import { buildMemoryContext } from '../memory/recall'
import { recordUsage } from '../usage/store'

const RESPONDER_PROMPT = `너는 다른 사용자의 에이전트로부터 온 질문에 답하는 응답 에이전트다.
너의 사용자의 지식베이스(공유 가능 항목만)를 근거로 도움이 되는 답변을 제공하라.

엄격한 규칙:
- 사용자의 개인정보, 자격증명(비밀번호·토큰·키), 회사 내부 경로·URL, 민감한 세부사항은 절대 답변에 포함하지 마라.
- 능력·지식·방법론만 공유하라. 확실하지 않으면 모른다고 답하라.
- 질문과 무관한 내부 정보를 흘리지 마라.
- 간결하고 실용적으로 답하라.`

/** 피어의 question 요청에 대해 지식베이스로 답변을 생성한다 (도구 없음, 공유 제외 기억 배제) */
export async function answerQuestion(question: string): Promise<string> {
  const memoryContext = buildMemoryContext(question, true)
  const system = memoryContext ? `${RESPONDER_PROMPT}\n\n${memoryContext}` : RESPONDER_PROMPT
  const { model, config } = getModelFor('standard')
  const { text, usage } = await generateText({
    model,
    system,
    prompt: question,
    stopWhen: stepCountIs(1)
  })
  recordUsage({ kind: 'network', provider: config.label, model: config.model, tier: 'standard' }, usage)
  return text.trim() || '답변을 생성하지 못했습니다.'
}
