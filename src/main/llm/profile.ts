import type { ProviderConfig } from '@shared/types'

/**
 * 로컬(온디바이스) 모델 프로파일.
 *
 * 클라우드 모델과 달리 로컬 모델은 컨텍스트 창이 좁다. Ollama 서버의 기본 num_ctx는
 * 4096이고, 이는 모델이 지원하는 최대 길이(qwen3.5:9b의 경우 262144)와 무관하게
 * `OLLAMA_CONTEXT_LENGTH`를 올리기 전까지 실제 한계로 작동한다. OpenAI 호환
 * 엔드포인트(/v1)는 요청 본문의 num_ctx를 무시하므로 앱에서 늘릴 수도 없다.
 *
 * 창을 넘긴 프롬프트는 오류가 아니라 조용한 절삭으로 이어진다 — 지시가 잘려나가
 * 없는 도구 이름을 지어내거나, 도구를 쓰지 않고 사용자에게 되묻거나, JSON 출력이
 * 중간에 끊긴다. 그래서 로컬 모델에서는 프롬프트·기억·도구 결과를 모두 예산 안으로
 * 줄이는 쪽을 기본값으로 삼는다.
 */
export interface ModelProfile {
  /** 로컬 서버에서 도는 모델인가 */
  local: boolean
  /** 이 모델이 한 요청에서 실제로 처리할 수 있는 총 토큰 */
  contextTokens: number
  /** 프롬프트(시스템 + 기억 + 도구 스키마 + 히스토리)에 쓸 수 있는 토큰 */
  promptBudget: number
  /** 출력 상한 — 로컬 모델에서만 지정한다 */
  maxOutputTokens?: number
  temperature?: number
  /** 한 턴에 허용할 도구 호출 스텝 수 */
  maxSteps: number
  /** 도구 결과 1건을 모델에 돌려줄 때의 문자 상한 */
  toolResultChars: number
}

/** 로컬 서버로 볼 호스트 */
const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?(\/|$)/i

/** Ollama 서버의 기본 num_ctx */
export const DEFAULT_LOCAL_CONTEXT = 4096
const DEFAULT_REMOTE_CONTEXT = 200_000

export function isLocalProvider(config: ProviderConfig): boolean {
  if (config.type === 'ollama') return true
  if (config.type === 'openai-compatible') return LOCAL_HOST.test((config.baseURL ?? '').trim())
  return false
}

export function profileFor(config: ProviderConfig): ModelProfile {
  const local = isLocalProvider(config)
  const configured = config.contextTokens && config.contextTokens > 0 ? config.contextTokens : 0
  const contextTokens = configured || (local ? DEFAULT_LOCAL_CONTEXT : DEFAULT_REMOTE_CONTEXT)

  if (!local) {
    return {
      local: false,
      contextTokens,
      promptBudget: Math.floor(contextTokens * 0.8),
      maxSteps: 25,
      toolResultChars: 200 * 1024
    }
  }

  const maxOutputTokens = Math.max(512, Math.min(2048, Math.floor(contextTokens / 4)))
  const promptBudget = Math.max(1024, contextTokens - maxOutputTokens - 256)
  return {
    local: true,
    contextTokens,
    promptBudget,
    maxOutputTokens,
    // 도구 호출 인자를 정확히 뽑는 게 문장력보다 중요하다
    temperature: 0.2,
    maxSteps: 12,
    // 도구 결과 한 건이 남은 창을 통째로 먹지 않도록 예산의 일부만 허용
    toolResultChars: Math.max(1200, Math.round(promptBudget * 0.6))
  }
}

/** 한글 자모·완성형과 CJK 통합 한자 — 이 구간은 문자당 토큰 비용이 ASCII의 두 배다 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/**
 * 대략적인 토큰 수. 정확한 토크나이저 대신, 한국어/CJK는 문자당 ~0.63토큰,
 * 그 외는 ~0.31토큰으로 잡는다 (qwen3.5 기준 실측에서 10% 남짓 과대평가 —
 * 예산은 넘치는 쪽보다 남는 쪽이 안전하다).
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjk(text.charCodeAt(i))) cjk++
  }
  return Math.ceil(cjk / 1.6 + (text.length - cjk) / 3.2)
}

/** 토큰 예산에 맞게 자른다. head=false면 뒤(최근)를 남긴다 */
export function fitToTokens(text: string, budgetTokens: number, head = true): string {
  if (budgetTokens <= 0) return ''
  if (estimateTokens(text) <= budgetTokens) return text
  // 문자 기준으로 근사 절삭 후, 넘치면 조금씩 더 줄인다
  let chars = Math.max(1, Math.floor(budgetTokens * 1.6))
  for (let i = 0; i < 5; i++) {
    const cut = head ? text.slice(0, chars) : text.slice(-chars)
    if (estimateTokens(cut) <= budgetTokens) return cut
    chars = Math.floor(chars * 0.8)
  }
  return head ? text.slice(0, chars) : text.slice(-chars)
}
