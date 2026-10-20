import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo, ProviderType } from '@shared/types'

interface Props {
  /** 저장된 프로바이더를 수정 중이면 그 id — 키체인의 키로 조회한다 */
  providerId?: string
  type: ProviderType
  baseURL?: string
  apiKey?: string
  /** 키체인에 이미 키가 있는가 (수정 중인 프로바이더) */
  hasStoredKey: boolean
  value: string
  onChange: (model: string) => void
}

/** 한 번에 그리는 항목 수 — OpenRouter처럼 수백 개를 주는 곳이 있다 */
const MAX_ROWS = 200

/**
 * 프로바이더가 제공하는 모델을 불러와 검색·선택하게 하는 콤보박스.
 *
 * 목록을 못 불러오는 환경(사내 프록시, 목록 API가 없는 호환 서버)도 있으므로
 * 직접 입력은 막지 않는다. 대신 목록에 없는 값이면 그렇다고 알려 준다.
 */
export default function ModelPicker({
  providerId,
  type,
  baseURL,
  apiKey,
  hasStoredKey,
  value,
  onChange
}: Props): JSX.Element {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const keyReady = type === 'ollama' || type === 'openai-compatible' || Boolean(apiKey) || hasStoredKey
  const urlReady = type !== 'openai-compatible' || Boolean(baseURL?.trim())
  const canFetch = keyReady && urlReady

  const load = async (): Promise<void> => {
    const my = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.listModels({
        id: providerId,
        type,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined
      })
      if (my === seq.current) setModels(list)
    } catch (e) {
      if (my !== seq.current) return
      setModels(null)
      // ipcRenderer.invoke는 "Error invoking remote method '...': Error: 원문" 형태로 감싼다
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }

  // 종류·주소·키가 바뀌면 이전 목록은 의미가 없다. 입력이 멈추면 다시 불러온다.
  useEffect(() => {
    seq.current++
    setModels(null)
    setError(null)
    setLoading(false)
    if (!canFetch) return
    const t = setTimeout(() => void load(), 600)
    return () => clearTimeout(t)
  }, [type, baseURL, apiKey, providerId, canFetch])

  const filtered = useMemo(() => {
    if (!models) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return models
    return models.filter((m) => {
      const hay = `${m.id} ${m.name ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [models, query])

  useEffect(() => setCursor(0), [query, models])

  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const pick = (m: ModelInfo): void => {
    onChange(m.id)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setCursor((c) => Math.min(c + 1, Math.min(filtered.length, MAX_ROWS) - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[cursor]) {
        e.preventDefault()
        pick(filtered[cursor])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const unknown = models !== null && value !== '' && !models.some((m) => m.id === value)
  const showList = open && models !== null

  let status: JSX.Element | null = null
  if (loading) status = <span>모델 목록을 불러오는 중…</span>
  else if (error)
    status = <span style={{ color: 'var(--danger)' }}>{error} — 모델 ID를 직접 입력할 수도 있습니다.</span>
  else if (!canFetch)
    status = (
      <span>{urlReady ? 'API 키를 입력하면' : 'Base URL을 입력하면'} 제공 모델 목록을 불러옵니다.</span>
    )
  else if (unknown)
    status = <span style={{ color: 'var(--warn)' }}>목록에 없는 모델입니다 — 이름을 확인하세요.</span>
  else if (models) status = <span>모델 {models.length.toLocaleString()}개 — 입력해서 검색하세요.</span>

  return (
    <div className="model-picker">
      <div className="model-picker-field">
        <div className="row">
          <input
            style={{ flex: 1 }}
            placeholder={models ? '모델 검색 (예: sonnet, gpt-4o, qwen)' : '모델 ID'}
            value={value}
            onFocus={() => {
              setQuery('')
              setOpen(true)
            }}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              setQuery(e.target.value)
              onChange(e.target.value)
              setOpen(true)
            }}
            onKeyDown={onKeyDown}
          />
          <button disabled={!canFetch || loading} onClick={() => void load()} title="모델 목록 다시 불러오기">
            새로고침
          </button>
        </div>
        {showList && (
          <div className="model-picker-list" ref={listRef}>
            {filtered.length === 0 && <div className="model-picker-empty">일치하는 모델이 없습니다</div>}
            {filtered.slice(0, MAX_ROWS).map((m, i) => (
              <div
                key={m.id}
                className={
                  'model-picker-item' + (i === cursor ? ' active' : '') + (m.id === value ? ' selected' : '')
                }
                // blur보다 먼저 잡아야 목록이 닫히기 전에 선택된다
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(m)
                }}
                onMouseEnter={() => setCursor(i)}
              >
                <span className="model-picker-id">{m.id}</span>
                {m.name && <span className="model-picker-meta">{m.name}</span>}
                {m.contextLength ? (
                  <span className="model-picker-meta">
                    {Math.round(m.contextLength / 1000).toLocaleString()}K
                  </span>
                ) : null}
              </div>
            ))}
            {filtered.length > MAX_ROWS && (
              <div className="model-picker-empty">
                외 {(filtered.length - MAX_ROWS).toLocaleString()}개 — 검색어로 좁혀 주세요
              </div>
            )}
          </div>
        )}
      </div>
      {status && <div className="model-picker-status">{status}</div>}
    </div>
  )
}
