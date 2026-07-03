import type { MemoryEntry, MemoryType } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

function loadAll(): MemoryEntry[] {
  return readJson<MemoryEntry[]>('memories.json', [])
}

function saveAll(entries: MemoryEntry[]): void {
  writeJson('memories.json', entries)
}

export function listMemories(includeArchived = false): MemoryEntry[] {
  const all = loadAll()
  return includeArchived ? all : all.filter((m) => m.status === 'active')
}

export function createMemory(
  data: Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags' | 'sourceSessionId'>
): MemoryEntry {
  const now = new Date().toISOString()
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    ...data,
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: now,
    status: 'active'
  }
  saveAll([...loadAll(), entry])
  return entry
}

export function updateMemory(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags' | 'status'>>
): MemoryEntry | null {
  const all = loadAll()
  const idx = all.findIndex((m) => m.id === id)
  if (idx < 0) return null
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() }
  saveAll(all)
  return all[idx]
}

export function deleteMemory(id: string): void {
  saveAll(loadAll().filter((m) => m.id !== id))
}

function markRecalled(ids: string[]): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const all = loadAll()
  for (const m of all) {
    if (ids.includes(m.id)) m.lastRecalledAt = now
  }
  saveAll(all)
}

/** 한글/영문 토큰화 — 공백 및 구두점 기준 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
}

/** 키워드 겹침 기반 점수. v2에서 로컬 임베딩 벡터 검색으로 교체 예정 */
function score(query: string[], m: MemoryEntry): number {
  const title = tokenize(m.title)
  const tags = m.tags.flatMap(tokenize)
  const content = tokenize(m.content)
  let s = 0
  for (const q of query) {
    if (title.some((t) => t.includes(q) || q.includes(t))) s += 3
    if (tags.some((t) => t.includes(q) || q.includes(t))) s += 2
    if (content.some((t) => t === q)) s += 1
  }
  return s
}

export function searchMemories(query: string, topK = 5, type?: MemoryType): MemoryEntry[] {
  const q = tokenize(query)
  if (q.length === 0) return []
  const candidates = listMemories().filter((m) => !type || m.type === type)
  const ranked = candidates
    .map((m) => ({ m, s: score(q, m) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
  markRecalled(ranked.map((r) => r.m.id))
  return ranked.map((r) => r.m)
}

export function searchLessons(query: string, topK = 3): MemoryEntry[] {
  return searchMemories(query, topK, 'lesson')
}
