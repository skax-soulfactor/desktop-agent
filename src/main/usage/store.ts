import type { ModelTier, UsageRecord } from '@shared/types'
import { appendLine, readLines } from '../storage/jsonStore'

const FILE = 'usage.jsonl'

/** AI SDK가 usage 필드를 못 채우는 프로바이더 대비 (undefined/NaN → 0) */
function n(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * LLM 호출 1건의 토큰 사용을 기록한다.
 * 실패해도 본 작업을 막으면 안 되므로 호출부에서 예외를 삼키지 않아도 되게 내부에서 처리한다.
 */
export function recordUsage(
  base: {
    sessionId?: string
    kind: UsageRecord['kind']
    provider: string
    model: string
    tier?: ModelTier
  },
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
): UsageRecord {
  const inputTokens = n(usage.inputTokens)
  const outputTokens = n(usage.outputTokens)
  const rec: UsageRecord = {
    at: new Date().toISOString(),
    ...base,
    inputTokens,
    outputTokens,
    totalTokens: n(usage.totalTokens) || inputTokens + outputTokens
  }
  try {
    appendLine(FILE, JSON.stringify(rec))
  } catch (e) {
    console.error('[usage] 기록 실패:', e)
  }
  return rec
}

/** 기간(ISO, 포함 범위) 내 사용 기록을 반환한다. 인자가 없으면 전체 */
export function listUsage(from?: string, to?: string): UsageRecord[] {
  return readLines(FILE, Number.MAX_SAFE_INTEGER)
    .map((line) => {
      try {
        return JSON.parse(line) as UsageRecord
      } catch {
        return null
      }
    })
    .filter((r): r is UsageRecord => r !== null)
    .filter((r) => (!from || r.at >= from) && (!to || r.at <= to))
}
