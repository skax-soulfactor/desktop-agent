import {
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type StopCondition,
  type ToolSet
} from 'ai'

interface CompleteOptions {
  model: LanguageModel
  system: string
  prompt: string
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[]
  /** 로컬 모델은 출력이 길어지면 컨텍스트를 넘겨 응답이 잘린다 — 프로파일 값을 넘긴다 */
  maxOutputTokens?: number
  temperature?: number
}

/**
 * 텍스트 1회 생성 — 겉보기는 generateText와 같지만 내부는 스트리밍(SSE)이다.
 *
 * 비스트리밍 응답은 본문 전체를 하나의 JSON 스키마로 검증하는데, OpenRouter 등 일부
 * 프로바이더는 200 응답에 에러 본문이나 잘린 본문을 실어 보낸다. 그러면 AI SDK가
 * 'Failed to process successful response'라는 껍데기 오류만 남기고 끝난다.
 * 스트리밍 청크 스키마는 에러 페이로드를 error 파트로 전달하므로 원인이 그대로 드러나고,
 * 응답이 끝날 때까지 수십 초를 무응답으로 붙잡고 있지도 않는다. 채팅 경로와 같은 경로다.
 *
 * finishReason을 함께 돌려준다. 이걸 버리면 출력 상한에 걸려 잘린 결과가 온전한 결과와
 * 구분되지 않는다 — 실제로 문서 병합 결과가 단어 중간에서 끊긴 채 사용자에게 갔고,
 * 잘렸다는 사실은 아무 데도 남지 않았다. 채팅 경로는 이미 종료 사유를 보고 알린다.
 */
export async function completeText(
  options: CompleteOptions
): Promise<{ text: string; usage: LanguageModelUsage; finishReason: FinishReason }> {
  const result = streamText(options)
  let text = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  return { text, usage: await result.totalUsage, finishReason: await result.finishReason }
}
