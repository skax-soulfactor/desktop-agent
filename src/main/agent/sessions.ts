import type { ModelMessage } from 'ai'
import type { ChatItem, SessionMeta } from '@shared/types'
import { readJson, writeJson, deleteFile, listFiles } from '../storage/jsonStore'

export interface SessionData {
  meta: SessionMeta
  /** 렌더러 표시용 */
  items: ChatItem[]
  /** LLM 히스토리 */
  messages: ModelMessage[]
}

export function listSessions(): SessionMeta[] {
  return listFiles('sessions')
    .map((f) => readJson<SessionData | null>(`sessions/${f}`, null))
    .filter((s): s is SessionData => s !== null)
    .map((s) => s.meta)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getSession(id: string): SessionData | null {
  return readJson<SessionData | null>(`sessions/${id}.json`, null)
}

export function createSession(): SessionData {
  const now = new Date().toISOString()
  const data: SessionData = {
    meta: { id: crypto.randomUUID(), title: '새 대화', createdAt: now, updatedAt: now },
    items: [],
    messages: []
  }
  saveSession(data)
  return data
}

export function saveSession(data: SessionData): void {
  data.meta.updatedAt = new Date().toISOString()
  writeJson(`sessions/${data.meta.id}.json`, data)
}

export function deleteSession(id: string): void {
  deleteFile(`sessions/${id}.json`)
}

/**
 * 읽기-수정-쓰기를 한 번에 수행하는 append.
 * 메인 턴과 백그라운드 작업이 같은 세션에 동시에 기록해도 서로의 변경을 덮어쓰지 않도록,
 * 항상 디스크의 최신 상태를 다시 읽어 덧붙인다 (동기 실행이라 원자적).
 */
export function appendToSession(id: string, items: ChatItem[], messages: ModelMessage[]): void {
  const fresh = getSession(id)
  if (!fresh) return
  fresh.items.push(...items)
  fresh.messages.push(...messages)
  saveSession(fresh)
}
