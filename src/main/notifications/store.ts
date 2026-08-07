import type { NotificationRecord } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

const FILE = 'notifications.json'
/** 보관 상한 — 넘으면 오래된 것부터 버린다 */
const MAX = 300

/** 저장 파일은 오래된 것 → 최신 순. 조회는 최신 순으로 뒤집어 준다 */
function load(): NotificationRecord[] {
  return readJson<NotificationRecord[]>(FILE, [])
}

function save(list: NotificationRecord[]): void {
  try {
    writeJson(FILE, list.slice(-MAX))
  } catch (e) {
    // 알림 기록 실패가 본 작업을 막으면 안 된다
    console.error('[notifications] 저장 실패:', e)
  }
}

/** 알림 1건을 기록한다 (최신 순 목록의 맨 앞에 오게 된다) */
export function addNotification(
  input: Omit<NotificationRecord, 'id' | 'at' | 'read'>
): NotificationRecord {
  const rec: NotificationRecord = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    read: false,
    ...input
  }
  const list = load()
  list.push(rec)
  save(list)
  return rec
}

/** 최신 순 알림 목록 */
export function listNotifications(): NotificationRecord[] {
  return load().reverse()
}

/** ids를 주면 해당 알림만, 없으면 전부 읽음 처리하고 남은 미확인 수를 반환한다 */
export function markNotificationsRead(ids?: string[]): number {
  const list = load()
  const target = ids ? new Set(ids) : null
  let changed = false
  for (const rec of list) {
    if (rec.read) continue
    if (target && !target.has(rec.id)) continue
    rec.read = true
    changed = true
  }
  if (changed) save(list)
  return list.filter((r) => !r.read).length
}

/** 전체 기록 삭제 */
export function clearNotifications(): void {
  save([])
}

export function unreadCount(): number {
  return load().filter((r) => !r.read).length
}
