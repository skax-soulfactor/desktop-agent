import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { Schedule } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'
import { startTask } from './tasks'
import { appendToSession } from './sessions'

const TICK_MS = 30_000
const MIN_INTERVAL_MINUTES = 5

function loadAll(): Schedule[] {
  return readJson<Schedule[]>('schedules.json', [])
}

function saveAll(schedules: Schedule[]): void {
  writeJson('schedules.json', schedules)
}

export function listSchedules(sessionId?: string): Schedule[] {
  return loadAll()
    .filter((s) => !sessionId || s.sessionId === sessionId)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
}

export function deleteSchedule(id: string): boolean {
  const all = loadAll()
  const next = all.filter((s) => s.id !== id)
  saveAll(next)
  return next.length < all.length
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  const all = loadAll()
  const s = all.find((x) => x.id === id)
  if (!s) return false
  s.enabled = enabled
  if (enabled) {
    // 다시 켤 때는 다음 실행 시각을 현재 기준으로 재계산 (밀린 실행 폭주 방지)
    const next = computeNext(s, new Date())
    if (next) s.nextRunAt = next
  }
  saveAll(all)
  return true
}

/** 다음 실행 시각 계산. once는 runAt 그대로, interval은 from+간격, daily는 오늘/내일의 HH:MM */
function computeNext(s: Schedule, from: Date): string | null {
  if (s.kind === 'once') {
    return s.runAt ?? null
  }
  if (s.kind === 'interval' && s.intervalMinutes) {
    return new Date(from.getTime() + s.intervalMinutes * 60_000).toISOString()
  }
  if (s.kind === 'daily' && s.timeOfDay) {
    const [h, m] = s.timeOfDay.split(':').map(Number)
    const candidate = new Date(from)
    candidate.setHours(h, m, 0, 0)
    if (candidate.getTime() <= from.getTime()) {
      candidate.setDate(candidate.getDate() + 1)
    }
    return candidate.toISOString()
  }
  return null
}

function createSchedule(
  data: Pick<Schedule, 'sessionId' | 'title' | 'instruction' | 'kind' | 'runAt' | 'intervalMinutes' | 'timeOfDay'>
): Schedule {
  const now = new Date()
  const draft: Schedule = {
    ...data,
    id: crypto.randomUUID(),
    enabled: true,
    nextRunAt: '',
    createdAt: now.toISOString()
  }
  const next = computeNext(draft, now)
  if (!next) throw new Error('스케줄 시각을 계산할 수 없습니다. 입력 값을 확인하세요.')
  draft.nextRunAt = next
  saveAll([...loadAll(), draft])
  return draft
}

let timer: NodeJS.Timeout | null = null

/** 앱 시작 시 1회 호출. 창이 없으면(닫힘) 실행을 미루고 다음 틱에 재시도한다 */
export function startScheduler(getWin: () => BrowserWindow | null): void {
  if (timer) return
  const tick = (): void => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const now = new Date()
    const all = loadAll()
    let changed = false
    for (const s of all) {
      if (!s.enabled || new Date(s.nextRunAt).getTime() > now.getTime()) continue
      changed = true
      s.lastRunAt = now.toISOString()
      if (s.kind === 'once') {
        s.enabled = false
      } else {
        s.nextRunAt = computeNext(s, now) ?? s.nextRunAt
      }
      try {
        startTask(win, s.sessionId, `[스케줄] ${s.title}`, s.instruction)
      } catch (e) {
        appendToSession(
          s.sessionId,
          [{ kind: 'notice', text: `스케줄 "${s.title}" 실행 실패: ${e instanceof Error ? e.message : String(e)}` }],
          []
        )
      }
    }
    if (changed) saveAll(all)
  }
  timer = setInterval(tick, TICK_MS)
  tick()
}

/** 메인(대화) 에이전트용 스케줄 관리 도구 */
export function scheduleTools(sessionId: string): ToolSet {
  return {
    schedule_task: tool({
      description:
        '작업을 예약한다. 사용자가 특정 시각 실행("오후 3시에...") 또는 주기 실행("1시간마다...", "매일 아침 9시에...")을 ' +
        '요청하면 사용하라. 실행 시점이 되면 백그라운드 서브 에이전트가 instruction을 수행한다. ' +
        '앱이 실행 중일 때만 동작한다는 점을 사용자에게 알려라.',
      inputSchema: z.object({
        title: z.string().describe('작업 제목 한 줄'),
        instruction: z.string().describe('서브 에이전트가 단독 수행할 자기완결적 지시'),
        kind: z.enum(['once', 'interval', 'daily']),
        runAt: z.string().optional().describe('kind=once: 실행 시각 ISO 8601 (예: 2026-07-06T15:00:00+09:00)'),
        intervalMinutes: z.number().optional().describe(`kind=interval: 실행 간격(분), 최소 ${MIN_INTERVAL_MINUTES}`),
        timeOfDay: z.string().optional().describe('kind=daily: 매일 실행 시각 "HH:MM" (24시간, 로컬 시간)')
      }),
      execute: async (input) => {
        try {
          if (input.kind === 'once') {
            if (!input.runAt || isNaN(Date.parse(input.runAt))) return { error: 'runAt(ISO 시각)이 필요합니다.' }
            if (Date.parse(input.runAt) <= Date.now()) return { error: 'runAt이 과거입니다. 미래 시각을 지정하세요.' }
          }
          if (input.kind === 'interval') {
            if (!input.intervalMinutes || input.intervalMinutes < MIN_INTERVAL_MINUTES)
              return { error: `intervalMinutes는 ${MIN_INTERVAL_MINUTES} 이상이어야 합니다.` }
          }
          if (input.kind === 'daily') {
            if (!input.timeOfDay || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay))
              return { error: 'timeOfDay는 "HH:MM" 형식이어야 합니다.' }
          }
          const s = createSchedule({ sessionId, ...input })
          return { scheduleId: s.id, nextRunAt: s.nextRunAt }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
    }),
    list_schedules: tool({
      description: '등록된 예약/주기 작업 목록과 다음 실행 시각을 반환한다.',
      inputSchema: z.object({}),
      execute: async () => listSchedules()
    }),
    cancel_schedule: tool({
      description: '예약/주기 작업을 삭제한다. 사용자가 스케줄 취소를 요청하면 list_schedules로 확인 후 사용하라.',
      inputSchema: z.object({ scheduleId: z.string() }),
      execute: async ({ scheduleId }) => {
        return deleteSchedule(scheduleId) ? { deleted: scheduleId } : { error: '해당 id의 스케줄이 없습니다.' }
      }
    })
  }
}
