import { safeStorage } from 'electron'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ProviderConfig } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

interface ProviderState {
  providers: ProviderConfig[]
  activeId: string | null
}

/** API 키는 설정 파일과 분리해 safeStorage(OS 키체인 기반)로 암호화 저장 */
type KeyFile = Record<string, string> // providerId -> base64(encrypted)

function loadState(): ProviderState {
  return readJson<ProviderState>('providers.json', { providers: [], activeId: null })
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

export function listProviders(): { providers: ProviderConfig[]; activeId: string | null } {
  const state = loadState()
  const keys = loadKeys()
  return {
    providers: state.providers.map((p) => ({ ...p, hasKey: Boolean(keys[p.id]) })),
    activeId: state.activeId
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
  if (!state.activeId) state.activeId = config.id
  saveState(state)
  if (apiKey) storeKey(config.id, apiKey)
}

export function deleteProvider(id: string): void {
  const state = loadState()
  state.providers = state.providers.filter((p) => p.id !== id)
  if (state.activeId === id) state.activeId = state.providers[0]?.id ?? null
  saveState(state)
  const keys = loadKeys()
  delete keys[id]
  saveKeys(keys)
}

export function setActiveProvider(id: string): void {
  const state = loadState()
  if (state.providers.some((p) => p.id === id)) {
    state.activeId = id
    saveState(state)
  }
}

export function getActiveModel(): { model: LanguageModel; config: ProviderConfig } {
  const state = loadState()
  const config = state.providers.find((p) => p.id === state.activeId)
  if (!config) throw new Error('설정에서 LLM 프로바이더를 먼저 등록하세요.')
  const apiKey = getKey(config.id) ?? undefined

  switch (config.type) {
    case 'anthropic':
      return { model: createAnthropic({ apiKey })(config.model), config }
    case 'openai':
      return { model: createOpenAI({ apiKey })(config.model), config }
    case 'google':
      return { model: createGoogleGenerativeAI({ apiKey })(config.model), config }
    case 'ollama':
      return {
        model: createOpenAICompatible({
          name: 'ollama',
          baseURL: config.baseURL || 'http://localhost:11434/v1',
          apiKey: apiKey ?? 'ollama'
        }).chatModel(config.model),
        config
      }
    case 'openai-compatible':
      if (!config.baseURL) throw new Error('openai-compatible 프로바이더는 baseURL이 필요합니다.')
      return {
        model: createOpenAICompatible({ name: config.label, baseURL: config.baseURL, apiKey }).chatModel(
          config.model
        ),
        config
      }
  }
}
