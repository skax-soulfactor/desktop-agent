import { safeStorage } from 'electron'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ModelTier, ProviderConfig, TierAssignment } from '@shared/types'
import { appendLine, readJson, writeJson } from '../storage/jsonStore'
import { enterpriseFetch } from '../tls'
import { isLocalProvider, probeServerContext, profileFor, type ModelProfile } from './profile'

interface ProviderState {
  providers: ProviderConfig[]
  /** 등급(경량/일반/고급)별 프로바이더 배정 */
  tiers: TierAssignment
}

/** API 키는 설정 파일과 분리해 safeStorage(OS 키체인 기반)로 암호화 저장 */
type KeyFile = Record<string, string> // providerId -> base64(encrypted)

const EMPTY_TIERS: TierAssignment = { light: null, standard: null, advanced: null }

function loadState(): ProviderState {
  const raw = readJson<Partial<ProviderState> & { activeId?: string | null }>('providers.json', {
    providers: [],
    tiers: { ...EMPTY_TIERS }
  })
  // 구버전(activeId 단일 선택) 마이그레이션: 기존 활성 프로바이더를 '일반' 등급으로
  const tiers: TierAssignment = raw.tiers ?? { ...EMPTY_TIERS, standard: raw.activeId ?? null }
  return { providers: raw.providers ?? [], tiers }
}

function saveState(state: ProviderState): void {
  writeJson('providers.json', state)
}

function loadKeys(): KeyFile {
  return readJson<KeyFile>('keys.json', {})
}

function saveKeys(keys: KeyFile): void {
  writeJson('keys.json', keys)
}

function storeKey(providerId: string, apiKey: string): void {
  const keys = loadKeys()
  if (safeStorage.isEncryptionAvailable()) {
    keys[providerId] = 'enc:' + safeStorage.encryptString(apiKey).toString('base64')
  } else {
    // 암호화 불가 환경(일부 Linux)에서는 평문 저장을 피하고 경고 접두어와 함께 저장
    keys[providerId] = 'raw:' + Buffer.from(apiKey).toString('base64')
  }
  saveKeys(keys)
}

function getKey(providerId: string): string | null {
  const stored = loadKeys()[providerId]
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  return Buffer.from(stored.slice(4), 'base64').toString('utf-8')
}

export function listProviders(): { providers: ProviderConfig[]; tiers: TierAssignment } {
  const state = loadState()
  const keys = loadKeys()
  return {
    providers: state.providers.map((p) => ({ ...p, hasKey: Boolean(keys[p.id]) })),
    tiers: state.tiers
  }
}

export function saveProvider(config: ProviderConfig, apiKey?: string): void {
  const state = loadState()
  const idx = state.providers.findIndex((p) => p.id === config.id)
  const clean: ProviderConfig = {
    id: config.id,
    type: config.type,
    label: config.label,
    model: config.model,
    baseURL: config.baseURL,
    contextTokens: config.contextTokens
  }
  if (idx >= 0) state.providers[idx] = clean
  else state.providers.push(clean)
  // 아무 등급도 배정되지 않았다면 첫 프로바이더를 '일반'으로
  if (!state.tiers.light && !state.tiers.standard && !state.tiers.advanced) {
    state.tiers.standard = config.id
  }
  saveState(state)
  if (apiKey) storeKey(config.id, apiKey)
}

export function deleteProvider(id: string): void {
  const state = loadState()
  state.providers = state.providers.filter((p) => p.id !== id)
  for (const tier of Object.keys(state.tiers) as ModelTier[]) {
    if (state.tiers[tier] === id) state.tiers[tier] = null
  }
  saveState(state)
  const keys = loadKeys()
  delete keys[id]
  saveKeys(keys)
}

export function setTier(tier: ModelTier, providerId: string | null): void {
  const state = loadState()
  if (providerId !== null && !state.providers.some((p) => p.id === providerId)) return
  state.tiers[tier] = providerId
  saveState(state)
}

/** 사용자가 전체 엔드포인트를 붙여 넣어도 동작하도록 정규화 — SDK가 /chat/completions를 스스로 붙인다 */
function normalizeBaseURL(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
}

/**
 * 로컬 서버(Ollama, LM Studio 등)의 OpenAI 호환 요청 본문에 표준 필드를 덧붙인다.
 *
 * - `reasoning_effort: 'none'` — qwen3 계열은 매 응답마다 <think> 블록을 먼저 생성한다.
 *   실측: "hi" 한 마디에 출력 269토큰 → 10토큰. 좁은 컨텍스트에서는 이 사고 과정이
 *   답을 밀어내 JSON 출력이 중간에 끊기는 원인이 된다.
 * - `stream_options.include_usage` — 이게 없으면 스트리밍 응답에 usage가 실리지 않아
 *   토큰 사용량이 항상 0으로 기록된다.
 *
 * 사고(thinking)를 지원하지 않는 모델은 reasoning_effort에 오류를 낼 수 있으므로,
 * 그 경우 한 번만 필드를 빼고 재시도한다.
 */
function patchLocalBody(init: RequestInit | undefined, withReasoning: boolean): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') return init
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(init.body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return init
    body = { ...(parsed as Record<string, unknown>) }
  } catch {
    return init
  }
  if (withReasoning && body.reasoning_effort === undefined) body.reasoning_effort = 'none'
  if (!withReasoning) delete body.reasoning_effort
  if (body.stream === true && body.stream_options === undefined) {
    body.stream_options = { include_usage: true }
  }
  return { ...init, body: JSON.stringify(body) }
}

async function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const patched = patchLocalBody(init, true)
  const res = await enterpriseFetch(input, patched)
  if (res.status >= 400 && patched !== init) {
    const detail = await res.clone().text()
    // "model does not support thinking" 류 — 사고 옵션만 빼고 한 번 더
    if (/think|reasoning/i.test(detail)) {
      return enterpriseFetch(input, patchLocalBody(init, false))
    }
  }
  return res
}

/**
 * 요청·응답을 그대로 파일에 남긴다 (`DA_LLM_TRACE=1`일 때만).
 *
 * 모델을 바꾼 뒤 응답이 빈 채로 돌아오는 일이 있었는데, 앱이 무엇을 보내고 무엇을 받았는지
 * 아무 데도 남지 않아 원인을 좁히지 못했다. 다음에 같은 일이 생기면 환경 변수 하나로
 * 배선을 볼 수 있어야 한다. 기본은 꺼짐 — 본문에는 대화 내용이 그대로 들어간다.
 */
/**
 * OpenAI 함수 스키마가 받지 않는 JSON Schema 키워드.
 *
 * 검증의 의미가 아니라 전달의 문제다. 이 키워드들은 OpenAI가 함수 정의에서 지원하지 않고,
 * 지원하지 않는 것을 만났을 때의 행동이 구현마다 다르다 — 조용히 무시하기도 하고, 400으로
 * 거절하기도 하고, 200을 주면서 본문을 비워 보내기도 한다(실제로 겪은 쪽이 마지막이다).
 *
 * 빼도 잃는 것은 모델에게 주는 힌트뿐이다. 인자 검증은 어차피 앱이 zod로 다시 하고,
 * 어긋나면 tool-error로 모델에게 돌아간다 — 계약은 그대로 지켜진다.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  // 스키마 문서의 메타 정보 — 파라미터의 일부가 아니다
  '$schema',
  // 문자열
  'minLength',
  'maxLength',
  'pattern',
  'format',
  // 숫자
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  // 배열
  'minItems',
  'maxItems',
  'uniqueItems',
  // 객체
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  // 값 자체를 바꿔 놓을 수 있는 것
  'default'
])

/** 스키마 트리에서 지원되지 않는 키워드를 걷어낸다. 걷어낸 개수를 돌려준다 */
function pruneSchema(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + pruneSchema(v), 0)
  if (typeof node !== 'object' || node === null) return 0
  let removed = 0
  for (const [key, value] of Object.entries(node)) {
    // properties 아래의 이름은 스키마 키워드가 아니라 사용자가 정한 필드 이름이다.
    // 거기까지 걷어내면 'pattern'이라는 이름의 파라미터가 사라진다.
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      removed += Object.values(value as Record<string, unknown>).reduce<number>(
        (n, v) => n + pruneSchema(v),
        0
      )
      continue
    }
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      delete (node as Record<string, unknown>)[key]
      removed++
      continue
    }
    removed += pruneSchema(value)
  }
  return removed
}

/**
 * 나가는 요청의 도구 스키마를 손질한다.
 *
 * 실측으로 좁힌 자리다. 도구 18개를 붙이면 OpenAI가 200을 주면서 본문 0자로 끝났고,
 * 상한을 4배로 올려도 같았고, 도구 3개로 줄이면 도구 호출까지 정상으로 돌았다. 그 3개
 * (fs_read·fs_list·shell_exec)에만 없고 나머지에는 있던 것이 이 키워드들이다.
 */
function sanitizeTools(init: RequestInit | undefined, id: number): RequestInit | undefined {
  if (!init || typeof init.body !== 'string' || !init.body.includes('"tools"')) return init
  let body: { tools?: { function?: { parameters?: unknown } }[] }
  try {
    body = JSON.parse(init.body) as typeof body
  } catch {
    return init
  }
  if (!Array.isArray(body.tools) || body.tools.length === 0) return init
  let removed = 0
  for (const tool of body.tools) removed += pruneSchema(tool.function?.parameters)
  if (removed === 0) return init
  trace('sanitize', { id, tools: body.tools.length, removedKeywords: removed })
  return { ...init, body: JSON.stringify(body) }
}

let traceSeq = 0

/** 응답 본문을 사본으로 읽어 남긴다 (`DA_LLM_TRACE=1`일 때만). 본 스트림은 그대로 흘러간다 */
function traceBody(id: number, res: Response): void {
  if (!process.env.DA_LLM_TRACE) return
  void res
    .clone()
    .text()
    .then((body) => trace('response-body', { id, chars: body.length, body: body.slice(0, 40_000) }))
    .catch((e: unknown) => trace('response-body', { id, error: String(e) }))
}

function trace(event: string, detail: unknown): void {
  if (!process.env.DA_LLM_TRACE) return
  try {
    appendLine('llm-trace.jsonl', JSON.stringify({ at: new Date().toISOString(), event, detail }))
  } catch {
    // 추적 실패가 대화를 막으면 안 된다
  }
}

/** 400 본문이 이 필드를 문제 삼고 있는가 */
function blames(detail: string, field: string): boolean {
  return new RegExp(`\\b${field}\\b`, 'i').test(detail)
}

/**
 * 400을 되받았을 때, 문제된 파라미터만 고친 본문을 만든다. 고칠 것이 없으면 null.
 *
 * OpenAI 호환이라는 이름은 엔드포인트 모양만 같다는 뜻이지 받는 파라미터가 같다는 뜻이
 * 아니다. 같은 OpenRouter 안에서도 deepseek 계열은 temperature·top_p·stop을 받지만
 * GPT-5 계열 추론 모델은 셋 다 거부하고 max_tokens 대신 max_completion_tokens를 쓴다.
 * 사용자가 설정에서 모델명만 바꾸면 이 차이가 그대로 요청에 실려 나간다 — 앱이 알아서
 * 맞춰 주지 않으면 사용자가 알 수 없는 이유로 대화가 죽는다.
 */
function reviseBody(rawBody: string, detail: string): string | null {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    body = { ...(parsed as Record<string, unknown>) }
  } catch {
    return null
  }

  let changed = false
  // max_tokens를 안 받는 모델은 대개 max_completion_tokens를 받는다. 그것도 아니라고 하면 뺀다.
  if (body.max_tokens !== undefined && blames(detail, 'max_tokens')) {
    if (blames(detail, 'max_completion_tokens') && body.max_completion_tokens === undefined) {
      body.max_completion_tokens = body.max_tokens
    }
    delete body.max_tokens
    changed = true
  }
  // 표본 추출 파라미터는 없어도 답은 나온다 — 거부당하면 그냥 뺀다
  for (const field of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop']) {
    if (body[field] !== undefined && blames(detail, field)) {
      delete body[field]
      changed = true
    }
  }
  return changed ? JSON.stringify(body) : null
}

/**
 * 원격 OpenAI 호환 서버(OpenRouter 등)로 나가는 요청.
 *
 * 본문을 미리 손대지는 않는다 — 프로바이더마다 해석이 달라서 먼저 고치면 멀쩡한 조합까지
 * 망가진다. 대신 서버가 400으로 어떤 필드가 문제인지 말해 주면, 그 필드만 고쳐 한 번 더
 * 보낸다. 재시도는 한 번뿐이다.
 */
async function remoteFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const id = ++traceSeq
  const cleaned = sanitizeTools(init, id)
  trace('request', { id, url: String(input), body: cleaned?.body })
  const res = await enterpriseFetch(input, cleaned)
  if (res.status !== 400 || !cleaned || typeof cleaned.body !== 'string') {
    trace('response', { id, status: res.status })
    // 상태 코드만으로는 아무것도 모른다 — 200을 받고도 본문이 빈 채로 끝난 턴이 실제로 있었다.
    // 사본을 따로 읽어 원문 그대로 남긴다. 본 응답 스트림은 건드리지 않는다.
    traceBody(id, res)
    return res
  }
  const detail = await res.clone().text()
  const revised = reviseBody(cleaned.body, detail)
  trace('retry', { id, status: 400, detail: detail.slice(0, 1000), revised })
  if (!revised) return res
  return enterpriseFetch(input, { ...cleaned, body: revised })
}

function buildModel(config: ProviderConfig): { model: LanguageModel; config: ProviderConfig } {
  const apiKey = getKey(config.id) ?? undefined
  const fetch = enterpriseFetch
  switch (config.type) {
    case 'anthropic':
      return { model: createAnthropic({ apiKey, fetch })(config.model), config }
    case 'openai':
      return { model: createOpenAI({ apiKey, fetch })(config.model), config }
    case 'google':
      return { model: createGoogleGenerativeAI({ apiKey, fetch })(config.model), config }
    case 'ollama':
      return {
        model: createOpenAICompatible({
          name: 'ollama',
          baseURL: normalizeBaseURL(config.baseURL || 'http://localhost:11434/v1'),
          apiKey: apiKey ?? 'ollama',
          fetch: localFetch,
          includeUsage: true
        }).chatModel(config.model),
        config
      }
    case 'openai-compatible':
      if (!config.baseURL) throw new Error('openai-compatible 프로바이더는 baseURL이 필요합니다.')
      return {
        model: createOpenAICompatible({
          name: config.label,
          baseURL: normalizeBaseURL(config.baseURL),
          apiKey,
          // 원격(OpenRouter 등)은 본문을 미리 건드리지 않는다 — 프로바이더마다 해석이
          // 달라진다. 서버가 거부한 뒤에 그 필드만 고치는 쪽이 remoteFetch다.
          fetch: isLocalProvider(config) ? localFetch : remoteFetch,
          // 이게 없으면 스트리밍 응답에 usage가 실리지 않아 사용량이 0으로 기록된다 —
          // 그러면 "토큰을 못 받은 것"과 "정말 0토큰인 것"을 구분할 수 없다
          includeUsage: true
        }).chatModel(config.model),
        config
      }
  }
}

/** 요청 등급 → 폴백 순서. 미배정 등급은 가까운 등급으로 대체한다 */
const FALLBACK_ORDER: Record<ModelTier, ModelTier[]> = {
  light: ['light', 'standard', 'advanced'],
  standard: ['standard', 'advanced', 'light'],
  advanced: ['advanced', 'standard', 'light']
}

export interface ResolvedModel {
  model: LanguageModel
  config: ProviderConfig
  /** 프롬프트·기억·도구 결과를 이 모델에 맞게 줄이기 위한 예산 */
  profile: ModelProfile
}

export function getModelFor(tier: ModelTier = 'standard'): ResolvedModel {
  const state = loadState()
  for (const t of FALLBACK_ORDER[tier]) {
    const id = state.tiers[t]
    const config = state.providers.find((p) => p.id === id)
    if (config) return { ...buildModel(config), profile: profileFor(config) }
  }
  throw new Error('설정에서 LLM 프로바이더를 등록하고 모델 역할(경량/일반/고급)을 배정하세요.')
}

/**
 * getModelFor와 같지만, 로컬 서버에 실제로 열린 창을 확인해 예산에 반영한다.
 * 프롬프트를 조립하는 경로(대화 턴, 워커, 배경 생성)는 이쪽을 써야 한다 —
 * 설정값만 믿으면 서버가 더 좁을 때 응답이 잘린다.
 */
export async function resolveModelFor(tier: ModelTier = 'standard'): Promise<ResolvedModel> {
  const resolved = getModelFor(tier)
  if (!isLocalProvider(resolved.config)) return resolved
  const serverContext = await probeServerContext(resolved.config)
  return { ...resolved, profile: profileFor(resolved.config, serverContext) }
}

/** 하위 호환: 기본(일반) 등급 모델 */
export function getActiveModel(): ResolvedModel {
  return getModelFor('standard')
}
