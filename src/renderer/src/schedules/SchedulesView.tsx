import { useEffect, useState } from 'react'
import type { Schedule } from '@shared/types'

function kindDesc(s: Schedule): string {
  if (s.kind === 'once') return `1회 — ${s.runAt ? new Date(s.runAt).toLocaleString() : '-'}`
  if (s.kind === 'interval') return `매 ${s.intervalMinutes}분`
  return `매일 ${s.timeOfDay}`
}

export default function SchedulesView(): JSX.Element {
  const [schedules, setSchedules] = useState<Schedule[]>([])

  const refresh = async (): Promise<void> => {
    setSchedules(await window.api.listSchedules())
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="page">
      <h2>예약 / 주기 작업</h2>
      <div className="card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        대화에서 "매일 아침 9시에 HN 주요 기사를 정리해서 옵시디안에 저장해줘"처럼 요청하면 스케줄이
        등록됩니다. 실행 시점이 되면 백그라운드 서브 에이전트가 작업을 수행하고, 해당 대화에 결과 카드가
        남습니다. 스케줄은 앱이 실행 중일 때만 동작합니다.
      </div>
      {schedules.length === 0 && <div className="empty">등록된 스케줄이 없습니다.</div>}
      {schedules.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>활성</th>
                <th>제목</th>
                <th>주기</th>
                <th>다음 실행</th>
                <th>마지막 실행</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => void window.api.toggleSchedule(s.id, e.target.checked).then(refresh)}
                    />
                  </td>
                  <td>{s.title}</td>
                  <td className="dim">{kindDesc(s)}</td>
                  <td className="dim">{s.enabled ? new Date(s.nextRunAt).toLocaleString() : '-'}</td>
                  <td className="dim">{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '-'}</td>
                  <td>
                    <button className="danger" onClick={() => void window.api.deleteSchedule(s.id).then(refresh)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
