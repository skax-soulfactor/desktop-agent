import { safeStorage } from 'electron'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ModelTier, ProviderConfig, TierAssignment } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'
import { enterpriseFetch } from '../tls'

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
    baseURL: config.baseURL
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
          fetch
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
          fetch
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

export function getModelFor(tier: ModelTier = 'standard'): { model: LanguageModel; config: ProviderConfig } {
  const state = loadState()
  for (const t of FALLBACK_ORDER[tier]) {
    const id = state.tiers[t]
    const config = state.providers.find((p) => p.id === id)
    if (config) return buildModel(config)
  }
  throw new Error('설정에서 LLM 프로바이더를 등록하고 모델 역할(경량/일반/고급)을 배정하세요.')
}

/** 하위 호환: 기본(일반) 등급 모델 */
export function getActiveModel(): { model: LanguageModel; config: ProviderConfig } {
  return getModelFor('standard')
}
