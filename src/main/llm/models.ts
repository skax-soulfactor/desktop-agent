import type { ModelInfo, ModelListRequest } from '@shared/types'
import { enterpriseFetch } from '../tls'
import { ollamaRoot } from './profile'
import { getKey } from './providers'

/**
 * 프로바이더가 실제로 제공하는 모델 목록을 가져온다.
 *
 * 설정 화면에서 모델 ID를 손으로 적게 하면 오타 하나로 대화가 404로 죽는데, 그 원인이
 * 모델명이라는 걸 사용자가 알아채기 어렵다. 저장 전 폼 값(종류·Base URL·키)만으로 조회해
 * 고를 수 있게 한다. 키는 renderer로 되돌려 보내지 않는다.
 */
export async function listModels(req: ModelListRequest): Promise<ModelInfo[]> {
  const apiKey = req.apiKey?.trim() || (req.id ? getKey(req.id) : null) || undefined
  const models = await fetchModels(req, apiKey)
  // 중복 제거 후 이름순 — 검색 결과가 늘 같은 순서로 보이도록
  const seen = new Map<string, ModelInfo>()
  for (const m of models) if (m.id && !seen.has(m.id)) seen.set(m.id, m)
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function fetchModels(req: ModelListRequest, apiKey: string | undefined): Promise<ModelInfo[]> {
  switch (req.type) {
    case 'anthropic':
      return anthropicModels(requireKey(apiKey))
    case 'openai':
      return (await openAIStyleModels('https://api.openai.com/v1', requireKey(apiKey))).filter((m) =>
        isOpenAIChatModel(m.id)
      )
    case 'google':
      return googleModels(requireKey(apiKey))
    case 'ollama':
      return ollamaModels(req.baseURL || 'http://localhost:11434/v1')
    case 'openai-compatible':
      if (!req.baseURL?.trim()) throw new Error('Base URL을 먼저 입력하세요.')
      return openAIStyleModels(req.baseURL, apiKey)
  }
}

function requireKey(apiKey: string | undefined): string {
  if (!apiKey) throw new Error('API 키를 먼저 입력하세요.')
  return apiKey
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await enterpriseFetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`인증 실패 (${res.status}) — API 키를 확인하세요.`)
    }
    throw new Error(`모델 목록 조회 실패 (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

async function anthropicModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = []
  let after: string | undefined
  // 페이지 수 상한 — 서버가 has_more를 잘못 줘도 무한히 돌지 않게
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '1000')
    if (after) url.searchParams.set('after_id', after)
    const body = await getJson<{
      data?: { id: string; display_name?: string }[]
      has_more?: boolean
      last_id?: string
    }>(url.toString(), { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
    for (const m of body.data ?? []) out.push({ id: m.id, name: m.display_name })
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  return out
}

/** OpenAI와 OpenAI 호환 서버(OpenRouter, vLLM, LM Studio 등)의 GET /models */
async function openAIStyleModels(baseURL: string, apiKey: string | undefined): Promise<ModelInfo[]> {
  const root = baseURL
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
  const body = await getJson<{
    data?: { id: string; name?: string; context_length?: number }[]
  }>(`${root}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  return (body.data ?? []).map((m) => ({
    id: m.id,
    name: m.name && m.name !== m.id ? m.name : undefined,
    contextLength: m.context_length
  }))
}

/** OpenAI /models에는 임베딩·음성·이미지 모델이 섞여 있다 — 대화에 못 쓰는 것은 뺀다 */
function isOpenAIChatModel(id: string): boolean {
  return !/embedding|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search/i.test(
    id
  )
}

async function googleModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    // 키는 URL이 아니라 헤더로 — 로그·프록시에 남지 않게
    const body = await getJson<{
      models?: {
        name: string
        displayName?: string
        inputTokenLimit?: number
        supportedGenerationMethods?: string[]
      }[]
      nextPageToken?: string
    }>(url.toString(), { 'x-goog-api-key': apiKey })
    for (const m of body.models ?? []) {
      if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes('generateContent')) continue
      out.push({
        id: m.name.replace(/^models\//, ''),
        name: m.displayName,
        contextLength: m.inputTokenLimit
      })
    }
    if (!body.nextPageToken) break
    pageToken = body.nextPageToken
  }
  return out
}

async function ollamaModels(baseURL: string): Promise<ModelInfo[]> {
  try {
    const body = await getJson<{ models?: { name?: string; model?: string }[] }>(
      `${ollamaRoot(baseURL)}/api/tags`,
      {}
    )
    return (body.models ?? []).map((m) => ({ id: m.model || m.name || '' }))
  } catch (e) {
    if (e instanceof Error && /fetch failed|ECONNREFUSED/i.test(`${e.message} ${String(e.cause)}`)) {
      throw new Error('Ollama 서버에 연결할 수 없습니다 — 서버가 실행 중인지, Base URL이 맞는지 확인하세요.')
    }
    throw e
  }
}
