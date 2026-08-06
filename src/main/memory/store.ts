import type {
  MemoryBulkAction,
  MemoryEntry,
  MemoryReviewItem,
  MemoryStats,
  MemoryType
} from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'
import { listSessions } from '../agent/sessions'

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

export function getMemory(id: string): MemoryEntry | null {
  return loadAll().find((m) => m.id === id) ?? null
}

export function createMemory(
  data: Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags' | 'sourceSessionId'> &
    Partial<Pick<MemoryEntry, 'origin' | 'pinned'>>
): MemoryEntry {
  const now = new Date().toISOString()
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    origin: 'agent',
    ...data,
    createdAt: now,
    updatedAt: now,
    // 생성은 회상이 아니다. 실제로 컨텍스트에 주입될 때까지 비워 둔다
    recallCount: 0,
    status: 'active'
  }
  saveAll([...loadAll(), entry])
  return entry
}

export function updateMemory(
  id: string,
  patch: Partial<
    Pick<
      MemoryEntry,
      'type' | 'title' | 'content' | 'tags' | 'status' | 'pinned' | 'reviewedAt' | 'origin'
    >
  >
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

/** 점검 대기함에서 "확인함" 처리 — 대상 항목을 대기함에서 내린다 */
export function markReviewed(id: string): MemoryEntry | null {
  return updateMemory(id, { reviewedAt: new Date().toISOString() })
}

/** 다중 선택 일괄 처리. 자동 축적 시스템에서 정리는 늘 배치 작업이다 */
export function bulkUpdate(ids: string[], action: MemoryBulkAction, tag?: string): number {
  if (ids.length === 0) return 0
  const targets = new Set(ids)
  if (action === 'delete') {
    const all = loadAll()
    const kept = all.filter((m) => !targets.has(m.id))
    saveAll(kept)
    return all.length - kept.length
  }
  const now = new Date().toISOString()
  const all = loadAll()
  let n = 0
  for (const m of all) {
    if (!targets.has(m.id)) continue
    if (action === 'archive') m.status = 'archived'
    else if (action === 'activate') m.status = 'active'
    else if (action === 'addTag' && tag && !m.tags.includes(tag)) m.tags.push(tag)
    else if (action === 'removeTag' && tag) m.tags = m.tags.filter((t) => t !== tag)
    else continue
    m.updatedAt = now
    n++
  }
  saveAll(all)
  return n
}

/**
 * 중복 병합 — keepId에 태그를 합집합으로 모으고 나머지는 보관 처리한다.
 * 본문은 사용자가 유지본을 직접 편집하도록 두고 자동 합치지 않는다 (내용 훼손 방지).
 */
export function mergeMemories(keepId: string, dropIds: string[]): MemoryEntry | null {
  const all = loadAll()
  const keep = all.find((m) => m.id === keepId)
  if (!keep) return null
  const now = new Date().toISOString()
  const drops = all.filter((m) => dropIds.includes(m.id) && m.id !== keepId)
  for (const d of drops) {
    for (const t of d.tags) if (!keep.tags.includes(t)) keep.tags.push(t)
    keep.recallCount = (keep.recallCount ?? 0) + (d.recallCount ?? 0)
    d.status = 'archived'
    d.updatedAt = now
  }
  keep.updatedAt = now
  keep.reviewedAt = now
  saveAll(all)
  return keep
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

/**
 * 순수 조회 — 부수효과가 없다. UI 검색과 주입 미리보기는 반드시 이쪽을 쓴다.
 * (회상 이력을 오염시키지 않기 위해 recallMemories와 분리되어 있다)
 */
export function queryMemories(query: string, topK = 5, type?: MemoryType): MemoryEntry[] {
  const q = tokenize(query)
  if (q.length === 0) return []
  return listMemories()
    .filter((m) => !type || m.type === type)
    .map((m) => ({ m, s: score(q, m) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((r) => r.m)
}

function markRecalled(ids: string[]): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const all = loadAll()
  for (const m of all) {
    if (!ids.includes(m.id)) continue
    m.lastRecalledAt = now
    m.recallCount = (m.recallCount ?? 0) + 1
  }
  saveAll(all)
}

/**
 * 회상 — 조회 후 사용 이력(lastRecalledAt, recallCount)을 기록한다.
 * 에이전트가 실제로 컨텍스트에 주입하는 경로에서만 호출할 것.
 */
export function recallMemories(query: string, topK = 5, type?: MemoryType): MemoryEntry[] {
  const hits = queryMemories(query, topK, type)
  markRecalled(hits.map((m) => m.id))
  return hits
}

export function searchLessons(query: string, topK = 3): MemoryEntry[] {
  return recallMemories(query, topK, 'lesson')
}

/** 고정 기억 — 검색과 무관하게 항상 주입된다 */
export function pinnedMemories(): MemoryEntry[] {
  return listMemories().filter((m) => m.pinned)
}

/**
 * 토큰 수 추정. 한글은 글자당 약 0.85토큰, 그 외(영문/기호/공백)는 4자당 1토큰으로 잡는다.
 * 정확한 값이 아니라 "기억이 늘면 매 턴 비용이 는다"를 사용자에게 보여주기 위한 지표다.
 */
export function estimateTokens(text: string): number {
  const hangul = (text.match(/[가-힣ᄀ-ᇿ㄰-㆏]/g) ?? []).length
  return Math.ceil(hangul / 1.2 + (text.length - hangul) / 4)
}

export function memoryStats(injectedBlock: string): MemoryStats {
  const all = loadAll()
  const active = all.filter((m) => m.status === 'active')
  const byType = { user: 0, requirement: 0, lesson: 0, reference: 0 } as Record<MemoryType, number>
  for (const m of active) byType[m.type]++
  return {
    total: active.length,
    archived: all.length - active.length,
    pinned: active.filter((m) => m.pinned).length,
    byType,
    injectedTokens: estimateTokens(injectedBlock),
    injectedChars: injectedBlock.length
  }
}

const STALE_DAYS = 30
const DUP_THRESHOLD = 0.5

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

/** 제목+태그 토큰의 자카드 유사도 */
function similarity(a: MemoryEntry, b: MemoryEntry): number {
  const sa = new Set([...tokenize(a.title), ...a.tags.flatMap(tokenize)])
  const sb = new Set([...tokenize(b.title), ...b.tags.flatMap(tokenize)])
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * 점검 대기함 — 룰 기반이라 LLM 호출 없이 즉시 계산된다.
 * 자동 축적의 진짜 문제는 "많다"가 아니라 "틀린 게 섞여 있는데 어느 게 틀렸는지 모른다"이다.
 */
export function needsReview(): MemoryReviewItem[] {
  const active = listMemories().filter((m) => !m.reviewedAt && !m.pinned)
  const items: MemoryReviewItem[] = []

  // 1) 중복 의심 — 같은 타입 안에서 제목·태그가 크게 겹치는 쌍
  const seen = new Set<string>()
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      if (a.type !== b.type) continue
      if (similarity(a, b) < DUP_THRESHOLD) continue
      const key = `${a.id}|${b.id}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        kind: 'duplicate',
        id: a.id,
        title: a.title,
        type: a.type,
        reason: '제목과 태그가 크게 겹칩니다. 하나로 합칠 수 있습니다.',
        pairId: b.id,
        pairTitle: b.title
      })
    }
  }
  const dupIds = new Set(items.map((i) => i.id))

  // 2) 노후 — 저장 후 한 번도 회상되지 않은 채 오래된 기억
  for (const m of active) {
    if (dupIds.has(m.id)) continue
    if ((m.recallCount ?? 0) > 0) continue
    const age = daysSince(m.lastRecalledAt ?? m.createdAt)
    if (age < STALE_DAYS) continue
    items.push({
      kind: 'stale',
      id: m.id,
      title: m.title,
      type: m.type,
      reason: `${Math.floor(age)}일 동안 한 번도 회상되지 않았습니다.`
    })
  }

  // 3) 형식 불일치 — lesson인데 재발 방지 규칙이 없으면 교훈으로 기능하지 못한다
  for (const m of active) {
    if (m.type !== 'lesson') continue
    if (m.content.includes('재발 방지')) continue
    items.push({
      kind: 'malformed',
      id: m.id,
      title: m.title,
      type: m.type,
      reason: '교훈에 "재발 방지" 항목이 없습니다. 규칙이 없으면 같은 실수를 막지 못합니다.'
    })
  }

  // 4) 출처 유실 — 근거가 된 대화가 삭제된 기억
  const sessionIds = new Set(listSessions().map((s) => s.id))
  for (const m of active) {
    if (!m.sourceSessionId || sessionIds.has(m.sourceSessionId)) continue
    items.push({
      kind: 'orphan',
      id: m.id,
      title: m.title,
      type: m.type,
      reason: '출처 대화가 삭제되어 근거를 확인할 수 없습니다.'
    })
  }

  return items
}

export function exportMemories(): MemoryEntry[] {
  return loadAll()
}

const TYPE_LABEL: Record<MemoryType, string> = {
  user: '사용자',
  requirement: '요구사항',
  lesson: '교훈',
  reference: '참조'
}

/** 사람이 읽는 백업본. 되돌려 가져오려면 JSON을 쓴다 */
export function exportMarkdown(): string {
  const all = loadAll()
  const lines = [`# 지식베이스 백업`, ``, `내보낸 시각: ${new Date().toLocaleString()}`, ``]
  for (const type of Object.keys(TYPE_LABEL) as MemoryType[]) {
    const group = all.filter((m) => m.type === type)
    if (group.length === 0) continue
    lines.push(`## ${TYPE_LABEL[type]} (${group.length})`, ``)
    for (const m of group) {
      const flags = [
        m.status === 'archived' ? '보관됨' : null,
        m.pinned ? '고정' : null,
        ...m.tags
      ].filter(Boolean)
      lines.push(`### ${m.title}`, ``)
      if (flags.length > 0) lines.push(`\`${flags.join('\` \`')}\``, ``)
      lines.push(m.content, ``, `— 생성 ${m.createdAt} · 갱신 ${m.updatedAt}`, ``)
    }
  }
  return lines.join('\n')
}

/** 가져오기 — 같은 id 또는 같은 타입+제목이 이미 있으면 건너뛴다 */
export function importMemories(incoming: MemoryEntry[]): { added: number; skipped: number } {
  const all = loadAll()
  const byId = new Set(all.map((m) => m.id))
  const byTitle = new Set(all.map((m) => `${m.type} ${m.title}`))
  let added = 0
  let skipped = 0
  for (const raw of incoming) {
    if (!raw || typeof raw.title !== 'string' || typeof raw.content !== 'string') {
      skipped++
      continue
    }
    if (byId.has(raw.id) || byTitle.has(`${raw.type} ${raw.title}`)) {
      skipped++
      continue
    }
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      ...raw,
      id: raw.id || crypto.randomUUID(),
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      status: raw.status === 'archived' ? 'archived' : 'active',
      createdAt: raw.createdAt || now,
      updatedAt: now
    }
    all.push(entry)
    byId.add(entry.id)
    byTitle.add(`${entry.type} ${entry.title}`)
    added++
  }
  saveAll(all)
  return { added, skipped }
}
