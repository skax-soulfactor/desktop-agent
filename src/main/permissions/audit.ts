import type { AuditRecord } from '@shared/types'
import { appendLine, readLines } from '../storage/jsonStore'

export function logAudit(record: AuditRecord): void {
  appendLine('audit.jsonl', JSON.stringify(record))
}

export function listAudit(lastN = 100): AuditRecord[] {
  return readLines('audit.jsonl', lastN)
    .map((l) => {
      try {
        return JSON.parse(l) as AuditRecord
      } catch {
        return null
      }
    })
    .filter((r): r is AuditRecord => r !== null)
    .reverse()
}
