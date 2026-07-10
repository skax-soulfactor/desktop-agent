import { safeStorage } from 'electron'
import type { SecretMeta } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

/**
 * 연동용 시크릿(API 토큰 등) 저장소.
 * 값은 safeStorage(OS 키체인 기반)로 암호화되며, 메인 프로세스 밖(renderer·LLM 프롬프트·대화 기록)으로
 * 원문이 나가지 않는다. 도구는 {{secret:이름}} 플레이스홀더로 참조하고 실행 직전에만 치환한다.
 */

interface SecretEntry {
  value: string // 'enc:' | 'raw:' 접두어 + base64
  createdAt: string
}

type SecretFile = Record<string, SecretEntry>

function load(): SecretFile {
  return readJson<SecretFile>('secrets.json', {})
}

function save(file: SecretFile): void {
  writeJson('secrets.json', file)
}

export function listSecrets(): SecretMeta[] {
  return Object.entries(load())
    .map(([name, e]) => ({ name, createdAt: e.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function hasSecret(name: string): boolean {
  return Boolean(load()[name])
}

export function setSecret(name: string, value: string): void {
  const file = load()
  const encoded = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(value).toString('base64')
    : 'raw:' + Buffer.from(value).toString('base64')
  file[name] = { value: encoded, createdAt: new Date().toISOString() }
  save(file)
}

export function deleteSecret(name: string): void {
  const file = load()
  delete file[name]
  save(file)
}

/** 메인 프로세스 전용 — renderer로 노출 금지 */
export function getSecret(name: string): string | null {
  const stored = load()[name]?.value
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  return Buffer.from(stored.slice(4), 'base64').toString('utf-8')
}

const PLACEHOLDER = /\{\{secret:([\w.-]+)\}\}/g

/** 문자열 안의 {{secret:이름}}을 실제 값으로 치환. 없는 시크릿을 참조하면 오류 */
export function resolveSecrets(text: string): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const v = getSecret(name)
    if (v === null) {
      throw new Error(
        `시크릿 "${name}"이 없습니다. request_secret 도구로 사용자에게 등록을 요청하세요.`
      )
    }
    return v
  })
}

/** 레코드의 모든 값에 resolveSecrets 적용 */
export function resolveSecretsInRecord(
  rec: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!rec) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) out[k] = resolveSecrets(v)
  return out
}
