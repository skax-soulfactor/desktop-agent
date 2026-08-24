import { streamText, type LanguageModel, type LanguageModelUsage, type StopCondition, type ToolSet } from 'ai'

interface CompleteOptions {
  model: LanguageModel
  system: string
  prompt: string
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[]
}

/**
 * 텍스트 1회 생성 — 겉보기는 generateText와 같지만 내부는 스트리밍(SSE)이다.
 *
 * 비스트리밍 응답은 본문 전체를 하나의 JSON 스키마로 검증하는데, OpenRouter 등 일부
 * 프로바이더는 200 응답에 에러 본문이나 잘린 본문을 실어 보낸다. 그러면 AI SDK가
 * 'Failed to process successful response'라는 껍데기 오류만 남기고 끝난다.
 * 스트리밍 청크 스키마는 에러 페이로드를 error 파트로 전달하므로 원인이 그대로 드러나고,
 * 응답이 끝날 때까지 수십 초를 무응답으로 붙잡고 있지도 않는다. 채팅 경로와 같은 경로다.
 */
export async function completeText(
  options: CompleteOptions
): Promise<{ text: string; usage: LanguageModelUsage }> {
  const result = streamText(options)
  let text = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  return { text, usage: await result.totalUsage }
}
