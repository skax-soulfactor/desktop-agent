import { useEffect, useMemo, useState } from 'react'
import type { UsageRecord } from '@shared/types'
import { fmtTokens } from '../lib/format'

type Mode = 'hourly' | 'daily' | 'monthly' | 'range'

const MODE_LABEL: Record<Mode, string> = {
  hourly: '시간별',
  daily: '일별',
  monthly: '월별',
  range: '기간 지정'
}

const KIND_LABEL: Record<UsageRecord['kind'], string> = {
  chat: '대화',
  task: '위임 작업',
  memory: '기억 추출',
  network: '네트워크'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 레코드의 로컬 시각 기준 버킷 키 */
function bucketKeyOf(at: string, mode: Mode): string {
  const d = new Date(at)
  if (mode === 'monthly') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  if (mode === 'hourly') return `${localDate(d)} ${pad(d.getHours())}`
  return localDate(d)
}

interface Bucket {
  key: string
  label: string
}

/** 빈 구간도 포함해 연속된 버킷 축을 만든다 */
function makeBuckets(mode: Mode, fromDate: string, toDate: string): Bucket[] {
  const buckets: Bucket[] = []
  const now = new Date()
  if (mode === 'hourly') {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3_600_000)
      buckets.push({ key: `${localDate(d)} ${pad(d.getHours())}`, label: `${d.getHours()}시` })
    }
  } else if (mode === 'daily') {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      buckets.push({ key: localDate(d), label: `${d.getMonth() + 1}/${d.getDate()}` })
    }
  } else if (mode === 'monthly') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      buckets.push({
        key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
        label: `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}`
      })
    }
  } else {
    const from = new Date(`${fromDate}T00:00:00`)
    const to = new Date(`${toDate}T00:00:00`)
    for (const d = new Date(from); d <= to && buckets.length < 366; d.setDate(d.getDate() + 1)) {
      buckets.push({ key: localDate(d), label: `${d.getMonth() + 1}/${d.getDate()}` })
    }
  }
  return buckets
}

/** 모드에 맞는 조회 범위 (ISO) */
function rangeFor(mode: Mode, fromDate: string, toDate: string): { from?: string; to?: string } {
  const now = new Date()
  if (mode === 'hourly') {
    const d = new Date(now.getTime() - 23 * 3_600_000)
    d.setMinutes(0, 0, 0)
    return { from: d.toISOString() }
  }
  if (mode === 'daily') {
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).toISOString() }
  }
  if (mode === 'monthly') {
    return { from: new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString() }
  }
  return {
    from: new Date(`${fromDate}T00:00:00`).toISOString(),
    to: new Date(`${toDate}T23:59:59.999`).toISOString()
  }
}

interface Agg {
  calls: number
  input: number
  output: number
  total: number
}

const EMPTY_AGG: Agg = { calls: 0, input: 0, output: 0, total: 0 }

function addTo(map: Map<string, Agg>, key: string, r: UsageRecord): void {
  const cur = map.get(key) ?? { ...EMPTY_AGG }
  cur.calls += 1
  cur.input += r.inputTokens
  cur.output += r.outputTokens
  cur.total += r.totalTokens
  map.set(key, cur)
}

export default function UsageView(): JSX.Element {
  const [mode, setMode] = useState<Mode>('daily')
  const today = localDate(new Date())
  const weekAgo = localDate(new Date(Date.now() - 6 * 86_400_000))
  const [fromDate, setFromDate] = useState(weekAgo)
  const [toDate, setToDate] = useState(today)
  const [records, setRecords] = useState<UsageRecord[] | null>(null)

  useEffect(() => {
    // 기간 지정에서 시작일이 종료일보다 늦으면 조회하지 않는다
    if (mode === 'range' && fromDate > toDate) return
    let cancelled = false
    setRecords(null)
    const { from, to } = rangeFor(mode, fromDate, toDate)
    void window.api.listUsage(from, to).then((rs) => {
      if (!cancelled) setRecords(rs)
    })
    return () => {
      cancelled = true
    }
  }, [mode, fromDate, toDate])

  const buckets = useMemo(() => makeBuckets(mode, fromDate, toDate), [mode, fromDate, toDate])

  const { byBucket, byKind, byModel, sum } = useMemo(() => {
    const byBucket = new Map<string, Agg>()
    const byKind = new Map<string, Agg>()
    const byModel = new Map<string, Agg>()
    const sum: Agg = { ...EMPTY_AGG }
    for (const r of records ?? []) {
      addTo(byBucket, bucketKeyOf(r.at, mode), r)
      addTo(byKind, r.kind, r)
      addTo(byModel, `${r.provider} · ${r.model}`, r)
      sum.calls += 1
      sum.input += r.inputTokens
      sum.output += r.outputTokens
      sum.total += r.totalTokens
    }
    return { byBucket, byKind, byModel, sum }
  }, [records, mode])

  const maxTotal = Math.max(1, ...buckets.map((b) => byBucket.get(b.key)?.total ?? 0))
  // 축 라벨은 겹치지 않게 최대 ~10개만 표시
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 10))

  return (
    <div className="page">
      <h2>토큰 사용량</h2>

      <div className="usage-controls">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button key={m} className={mode === m ? 'primary' : ''} onClick={() => setMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
        {mode === 'range' && (
          <span className="range-inputs">
            <input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} />
            <span className="dim">~</span>
            <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
          </span>
        )}
      </div>

      <div className="usage-tiles">
        <div className="tile">
          <div className="tile-label">총 토큰</div>
          <div className="tile-value">{fmtTokens(sum.total)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">입력 토큰</div>
          <div className="tile-value">{fmtTokens(sum.input)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">출력 토큰</div>
          <div className="tile-value">{fmtTokens(sum.output)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">LLM 호출</div>
          <div className="tile-value">{sum.calls.toLocaleString()}회</div>
        </div>
      </div>

      <div className="card">
        <div className="chart-title">구간별 총 토큰</div>
        {records === null ? (
          <div className="empty">불러오는 중…</div>
        ) : sum.calls === 0 ? (
          <div className="empty">이 기간에 기록된 사용량이 없습니다.</div>
        ) : (
          <div className="usage-chart" role="img" aria-label="구간별 토큰 사용량 막대 차트">
            {buckets.map((b, i) => {
              const a = byBucket.get(b.key)
              const h = a ? Math.max(2, Math.round((a.total / maxTotal) * 100)) : 0
              return (
                <div key={b.key} className="col">
                  <div className="bar-area">
                    {a && (
                      <div className="bar" style={{ height: `${h}%` }}>
                        <div className="tip">
                          <b>{b.label}</b>
                          <span>총 {fmtTokens(a.total)}</span>
                          <span>입력 {fmtTokens(a.input)} · 출력 {fmtTokens(a.output)}</span>
                          <span>{a.calls}회 호출</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="x-label">{i % labelEvery === 0 ? b.label : ''}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {sum.calls > 0 && (
        <div className="usage-breakdowns">
          <div className="card">
            <div className="chart-title">분류별</div>
            <table>
              <thead>
                <tr>
                  <th>분류</th>
                  <th>호출</th>
                  <th>입력</th>
                  <th>출력</th>
                  <th>총</th>
                </tr>
              </thead>
              <tbody>
                {[...byKind.entries()]
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([kind, a]) => (
                    <tr key={kind}>
                      <td>{KIND_LABEL[kind as UsageRecord['kind']] ?? kind}</td>
                      <td className="dim">{a.calls}</td>
                      <td className="dim">{fmtTokens(a.input)}</td>
                      <td className="dim">{fmtTokens(a.output)}</td>
                      <td>{fmtTokens(a.total)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="chart-title">모델별</div>
            <table>
              <thead>
                <tr>
                  <th>모델</th>
                  <th>호출</th>
                  <th>입력</th>
                  <th>출력</th>
                  <th>총</th>
                </tr>
              </thead>
              <tbody>
                {[...byModel.entries()]
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([model, a]) => (
                    <tr key={model}>
                      <td>{model}</td>
                      <td className="dim">{a.calls}</td>
                      <td className="dim">{fmtTokens(a.input)}</td>
                      <td className="dim">{fmtTokens(a.output)}</td>
                      <td>{fmtTokens(a.total)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sum.calls > 0 && (
        <div className="card">
          <div className="chart-title">구간별 상세</div>
          <table>
            <thead>
              <tr>
                <th>구간</th>
                <th>호출</th>
                <th>입력</th>
                <th>출력</th>
                <th>총</th>
              </tr>
            </thead>
            <tbody>
              {[...buckets]
                .reverse()
                .filter((b) => byBucket.has(b.key))
                .map((b) => {
                  const a = byBucket.get(b.key)!
                  return (
                    <tr key={b.key}>
                      <td>{b.key}</td>
                      <td className="dim">{a.calls}</td>
                      <td className="dim">{a.input.toLocaleString()}</td>
                      <td className="dim">{a.output.toLocaleString()}</td>
                      <td>{a.total.toLocaleString()}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
