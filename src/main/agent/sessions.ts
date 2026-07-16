import type { ModelMessage } from 'ai'
import type { ChatItem, SessionMeta, SessionSearchHit } from '@shared/types'
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

/** 세션 누적 토큰 카운터를 증가시킨다 (읽기-수정-쓰기, 동기 실행이라 원자적) */
export function addSessionUsage(id: string, input: number, output: number): void {
  if (input <= 0 && output <= 0) return
  const fresh = getSession(id)
  if (!fresh) return
  fresh.meta.inputTokens = (fresh.meta.inputTokens ?? 0) + input
  fresh.meta.outputTokens = (fresh.meta.outputTokens ?? 0) + output
  saveSession(fresh)
}

/** 일치 지점 주변을 잘라 발췌를 만든다 */
function makeSnippet(text: string, pos: number, matchLen: number): string {
  const CONTEXT = 40
  const start = Math.max(0, pos - CONTEXT)
  const end = Math.min(text.length, pos + matchLen + CONTEXT)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return head + text.slice(start, end).replace(/\n+/g, ' ') + tail
}

/**
 * 모든 세션의 제목과 사용자/에이전트 메시지를 대소문자 구분 없이 검색한다.
 * 최근 대화 순으로 훑고, 세션당 메시지 일치는 여러 건 나올 수 있다.
 */
export function searchSessions(query: string, limit = 50): SessionSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SessionSearchHit[] = []
  const sessions = listFiles('sessions')
    .map((f) => readJson<SessionData | null>(`sessions/${f}`, null))
    .filter((s): s is SessionData => s !== null)
    .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
  for (const s of sessions) {
    if (hits.length >= limit) break
    const base = { sessionId: s.meta.id, title: s.meta.title, updatedAt: s.meta.updatedAt }
    if (s.meta.title.toLowerCase().includes(q)) {
      hits.push({ ...base, itemIndex: -1, kind: 'title', snippet: s.meta.title })
    }
    for (let i = 0; i < s.items.length && hits.length < limit; i++) {
      const it = s.items[i]
      if (it.kind !== 'user' && it.kind !== 'assistant') continue
      const pos = it.text.toLowerCase().indexOf(q)
      if (pos < 0) continue
      hits.push({ ...base, itemIndex: i, kind: it.kind, snippet: makeSnippet(it.text, pos, q.length) })
    }
  }
  return hits
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
