import { useEffect, useRef, useState } from 'react'
import type {
  AttachmentPayload,
  ChatItem,
  SessionMeta,
  SessionSearchHit,
  TaskInfo,
  TokenUsage
} from '@shared/types'
import Markdown from './Markdown'
import { fmtTokens } from '../lib/format'

interface PendingAttachment extends AttachmentPayload {
  previewUrl?: string
}

const MAX_ATTACHMENTS = 5
const MAX_ATTACH_BYTES = 15 * 1024 * 1024

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('파일 읽기 실패'))
    r.readAsDataURL(f)
  })
}

function formatTime(at?: string): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // clipboard API가 막힌 환경(file:// 등) 대비 폴백
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** 사용자 메시지 앞의 인용 블록("> ...")을 분리해 스타일링할 수 있게 한다 */
function splitLeadingQuote(text: string): { quote?: string; body: string } {
  const lines = text.split('\n')
  if (!lines[0]?.startsWith('> ')) return { body: text }
  const q: string[] = []
  let i = 0
  while (i < lines.length && lines[i].startsWith('> ')) {
    q.push(lines[i].slice(2))
    i++
  }
  while (i < lines.length && lines[i].trim() === '') i++
  return { quote: q.join('\n'), body: lines.slice(i).join('\n') }
}

/** 복사·시간·토큰 메타 행 — 사용자/에이전트 메시지 공용 */
function MsgMeta({
  at,
  copied,
  onCopy,
  usage
}: {
  at?: string
  copied: boolean
  onCopy: () => void
  usage?: TokenUsage
}): JSX.Element {
  return (
    <div className="msg-meta">
      {at && <span className="time">{formatTime(at)}</span>}
      {usage && (
        <span className="tokens" title="이 턴에서 사용한 토큰 (도구 호출 포함) — 입력 ↑ / 출력 ↓">
          ↑{fmtTokens(usage.input)} ↓{fmtTokens(usage.output)}
        </span>
      )}
      <button className="copy" onClick={onCopy} title="마크다운 원문 복사">
        {copied ? '복사됨 ✓' : '복사'}
      </button>
    </div>
  )
}

/** 발췌 안의 검색어 첫 일치를 강조 표시 */
function HighlightedSnippet({ text, query }: { text: string; query: string }): JSX.Element {
  const q = query.trim().toLowerCase()
  const pos = q ? text.toLowerCase().indexOf(q) : -1
  if (pos < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, pos)}
      <mark>{text.slice(pos, pos + q.length)}</mark>
      {text.slice(pos + q.length)}
    </>
  )
}

const HIT_KIND_LABEL: Record<SessionSearchHit['kind'], string> = {
  title: '제목',
  user: '나',
  assistant: '에이전트'
}

const TIER_LABEL: Record<string, string> = { light: '경량', standard: '일반', advanced: '고급' }

const TOOL_STATUS_LABEL: Record<string, string> = {
  running: '실행 중',
  done: '완료',
  denied: '거부됨',
  error: '오류',
  aborted: '중단됨'
}

function ToolCard({ item }: { item: ChatItem & { kind: 'tool' } }): JSX.Element {
  return (
    <div className="toolcard">
      <div className="head">
        <span className={`badge ${item.status}`}>{TOOL_STATUS_LABEL[item.status]}</span>
        <span>{item.summary}</span>
      </div>
      {item.output && <pre>{item.output}</pre>}
    </div>
  )
}

/** 워커(서브 에이전트)의 작업 과정 — 메인 대화처럼 텍스트와 도구 카드를 순서대로 표시 */
function WorkLog({ items }: { items: ChatItem[] }): JSX.Element {
  return (
    <div className="worklog">
      {items.length === 0 && <div className="empty">아직 활동이 없습니다.</div>}
      {items.map((it, i) => {
        if (it.kind === 'assistant')
          return (
            <div key={i} className="msg assistant">
              <Markdown text={it.text} />
            </div>
          )
        if (it.kind === 'tool') return <ToolCard key={i} item={it} />
        return null
      })}
    </div>
  )
}

export default function ChatView(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [runningTasks, setRunningTasks] = useState<TaskInfo[]>([])
  /** 실시간 과정을 펼쳐 보는 진행 중 작업 id */
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  /** 과정을 펼친 완료 작업 카드의 taskId 집합 */
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  /** 방금 복사한 메시지 인덱스 (버튼 피드백용) */
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 다음 전송에 인용으로 첨부할 선택 텍스트 */
  const [quote, setQuote] = useState<string | null>(null)
  /** 대화 기록 검색어 — 입력 중이면 사이드바가 검색 결과 모드로 전환된다 */
  const [search, setSearch] = useState('')
  /** null = 검색 중(디바운스 대기 포함) */
  const [searchHits, setSearchHits] = useState<SessionSearchHit[] | null>(null)
  /** 검색 결과 클릭 시 세션 로드 후 스크롤할 메시지 인덱스 */
  const pendingScrollIdx = useRef<number | null>(null)
  /** 잠시 강조 표시할 메시지 인덱스 */
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 드래그 선택 위에 띄우는 "인용" 버튼 위치와 대상 텍스트 */
  const [selPop, setSelPop] = useState<{ x: number; y: number; text: string } | null>(null)

  const copyMessage = (text: string, idx: number): void => {
    void copyText(text)
    setCopiedIdx(idx)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedIdx(null), 1500)
  }

  const onMessagesMouseUp = (): void => {
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : ''
    if (!sel || !text) {
      setSelPop(null)
      return
    }
    const anchor = sel.anchorNode
    const el = anchor instanceof Element ? anchor : anchor?.parentElement
    if (!el?.closest('.msg')) {
      setSelPop(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelPop({ x: rect.left + rect.width / 2, y: rect.top, text })
  }

  const refreshSessions = async (): Promise<void> => {
    setSessions(await window.api.listSessions())
  }

  useEffect(() => {
    void (async () => {
      const list = await window.api.listSessions()
      setSessions(list)
      if (list.length > 0) {
        await openSession(list[0].id)
      } else {
        const s = await window.api.createSession()
        setSessions([s.meta])
        setActiveId(s.meta.id)
        setItems([])
      }
    })()
  }, [])

  useEffect(() => {
    return window.api.onChatEvent((e) => {
      if (e.sessionId !== activeIdRef.current) return
      if (e.type === 'turn-start') {
        setBusy(true)
        setError(null)
      } else if (e.type === 'text-delta') {
        setItems((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.kind === 'assistant') {
            return [...prev.slice(0, -1), { ...last, text: last.text + e.text }]
          }
          return [...prev, { kind: 'assistant', text: e.text, at: new Date().toISOString() }]
        })
      } else if (e.type === 'tool-call') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'tool',
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            summary: e.summary,
            status: 'running'
          }
        ])
      } else if (e.type === 'tool-result') {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.toolCallId === e.toolCallId
              ? { ...it, status: e.status, output: e.output }
              : it
          )
        )
      } else if (e.type === 'memory-saved') {
        setItems((prev) => [...prev, { kind: 'memory', ops: e.ops }])
      } else if (e.type === 'notice') {
        setItems((prev) => [...prev, { kind: 'notice', text: e.text }])
      } else if (e.type === 'task-update') {
        const t = e.task
        if (t.status === 'running') {
          // 진행 중: 작업 표시줄에 추가/갱신
          setRunningTasks((prev) => {
            const idx = prev.findIndex((x) => x.id === t.id)
            if (idx >= 0) return prev.map((x, i) => (i === idx ? t : x))
            return [...prev, t]
          })
        } else {
          // 종료: 표시줄에서 제거하고 결과 카드(과정 로그 포함)를 대화에 추가
          setRunningTasks((prev) => prev.filter((x) => x.id !== t.id))
          // 작업도 세션 누적 토큰에 반영되므로 메타를 다시 읽는다
          void refreshSessions()
          setExpandedTaskId((prev) => (prev === t.id ? null : prev))
          setItems((prev) => [
            ...prev,
            {
              kind: 'task',
              taskId: t.id,
              title: t.title,
              status: t.status,
              result: t.result,
              log: t.log,
              usage: t.usage
            }
          ])
        }
      } else if (e.type === 'turn-end') {
        setBusy(false)
        if (e.error) setError(e.error)
        // 이 턴의 토큰 사용량을 마지막 에이전트 메시지에 귀속 (저장본과 동일한 위치)
        if (e.usage) {
          const usage = e.usage
          setItems((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].kind === 'assistant') {
                return prev.map((it, j) => (j === i ? { ...it, usage } : it))
              }
            }
            return prev
          })
        }
        // 아직 '실행 중'으로 남은 도구 카드를 '중단됨'으로 확정해 스피너가 무한히 도는 현상을 막는다
        if (e.unresolvedToolCallIds.length > 0) {
          const stuck = new Set(e.unresolvedToolCallIds)
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.status === 'running' && stuck.has(it.toolCallId)
                ? { ...it, status: 'aborted' as const }
                : it
            )
          )
        }
        void refreshSessions()
      }
    })
  }, [])

  // 대화 기록 검색 (디바운스)
  useEffect(() => {
    if (!search.trim()) {
      setSearchHits(null)
      return
    }
    setSearchHits(null)
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.searchSessions(search).then((hits) => {
        if (!cancelled) setSearchHits(hits)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search])

  useEffect(() => {
    // 검색 결과에서 진입한 경우 해당 메시지로, 그 외에는 맨 아래로 스크롤
    if (pendingScrollIdx.current !== null) {
      const idx = pendingScrollIdx.current
      pendingScrollIdx.current = null
      document
        .querySelector(`.messages [data-idx="${idx}"]`)
        ?.scrollIntoView({ block: 'center' })
      setHighlightIdx(idx)
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setHighlightIdx(null), 2000)
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [items])

  const openSession = async (id: string): Promise<void> => {
    const s = await window.api.getSession(id)
    if (s) {
      setActiveId(id)
      setItems(s.items)
      setError(null)
      setQuote(null)
      setSelPop(null)
      // 버튼 상태를 이벤트가 아닌 실제 실행 여부로 동기화 (세션 전환·이벤트 누락 시 desync 방지)
      setBusy(await window.api.chatIsRunning(id))
      setRunningTasks((await window.api.listTasks(id)).filter((t) => t.status === 'running'))
    }
  }

  const openHit = async (hit: SessionSearchHit): Promise<void> => {
    if (hit.itemIndex >= 0) pendingScrollIdx.current = hit.itemIndex
    await openSession(hit.sessionId)
  }

  const newSession = async (): Promise<void> => {
    const s = await window.api.createSession()
    await refreshSessions()
    setActiveId(s.meta.id)
    setItems([])
    setBusy(false)
    setRunningTasks([])
  }

  const removeSession = async (id: string): Promise<void> => {
    await window.api.deleteSession(id)
    const list = await window.api.listSessions()
    setSessions(list)
    if (activeId === id) {
      if (list.length > 0) await openSession(list[0].id)
      else await newSession()
    }
  }

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    for (const f of files) {
      if (f.size > MAX_ATTACH_BYTES) {
        setError(`"${f.name}"은 15MB를 초과해 첨부할 수 없습니다.`)
        continue
      }
      try {
        const dataBase64 = await fileToBase64(f)
        const att: PendingAttachment = {
          name: f.name || 'clipboard-image.png',
          mimeType: f.type,
          dataBase64,
          previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined
        }
        setPending((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, att]))
      } catch {
        setError(`"${f.name}" 읽기에 실패했습니다.`)
      }
    }
  }

  const removePending = (idx: number): void => {
    setPending((prev) => {
      const target = prev[idx]
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const send = (): void => {
    const text = input.trim()
    if ((!text && pending.length === 0 && !quote) || busy || !activeId) return
    // 인용이 있으면 마크다운 블록쿼트로 앞에 붙여 원문 맥락을 함께 전달한다
    const finalText = quote ? `> ${quote.replace(/\n/g, '\n> ')}\n\n${text}` : text
    const attachments = pending.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }))
    const metas = pending.map(({ name, mimeType }) => ({ name, mimeType }))
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    setInput('')
    setPending([])
    setQuote(null)
    void window.api.chatSend(activeId, finalText, attachments)
    setItems((prev) => [
      ...prev,
      {
        kind: 'user',
        text: finalText,
        at: new Date().toISOString(),
        ...(metas.length > 0 ? { attachments: metas } : {})
      }
    ])
    setBusy(true)
  }

  return (
    <>
      <div className="sidebar">
        <button onClick={() => void newSession()}>+ 새 대화</button>
        <div className="search-box">
          <input
            value={search}
            placeholder="대화 기록 검색"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearch('')
            }}
          />
          {search && (
            <button className="clear" title="검색 지우기" onClick={() => setSearch('')}>
              ×
            </button>
          )}
        </div>
        {search.trim() ? (
          <div className="search-results">
            {searchHits === null && <div className="search-note">검색 중…</div>}
            {searchHits?.length === 0 && <div className="search-note">일치하는 대화가 없습니다.</div>}
            {searchHits?.map((h, i) => (
              <div key={i} className="search-hit" onClick={() => void openHit(h)}>
                <div className="hit-title">{h.title}</div>
                <div className="hit-snippet">
                  <span className="hit-kind">{HIT_KIND_LABEL[h.kind]}</span>
                  <HighlightedSnippet text={h.snippet} query={search} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`session ${s.id === activeId ? 'active' : ''}`}
              onClick={() => void openSession(s.id)}
            >
              <span>{s.title}</span>
              <button
                className="del"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeSession(s.id)
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <div
        className="main"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files)
        }}
      >
        {(() => {
          const meta = sessions.find((s) => s.id === activeId)
          const input = meta?.inputTokens ?? 0
          const output = meta?.outputTokens ?? 0
          if (input + output === 0) return null
          return (
            <div className="session-usage" title="이 세션에서 누적 사용한 토큰 (대화 + 위임 작업 포함)">
              세션 토큰 — 입력 {fmtTokens(input)} · 출력 {fmtTokens(output)} · 총{' '}
              {fmtTokens(input + output)}
            </div>
          )
        })()}
        <div className="messages" onMouseUp={onMessagesMouseUp} onScroll={() => setSelPop(null)}>
          {items.length === 0 && (
            <div className="empty">무엇을 도와드릴까요? 파일 정리, 스크립트 실행 등 데스크톱 작업을 요청해 보세요.</div>
          )}
          {items.map((it, i) => {
            if (it.kind === 'user') {
              const { quote: q, body } = splitLeadingQuote(it.text)
              return (
                <div key={i} data-idx={i} className={`msg-wrap user ${highlightIdx === i ? 'hl' : ''}`}>
                  <div className="msg user">
                    {q && <div className="uquote">{q}</div>}
                    {body}
                    {it.attachments && it.attachments.length > 0 && (
                      <div className="file-chips">
                        {it.attachments.map((a, j) => (
                          <span key={j} className="file-chip">
                            {a.mimeType.startsWith('image/') ? '이미지' : '파일'} · {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <MsgMeta at={it.at} copied={copiedIdx === i} onCopy={() => copyMessage(it.text, i)} />
                </div>
              )
            }
            if (it.kind === 'assistant')
              return (
                <div key={i} data-idx={i} className={`msg-wrap assistant ${highlightIdx === i ? 'hl' : ''}`}>
                  <div className="msg assistant">
                    <Markdown text={it.text} />
                  </div>
                  <MsgMeta
                    at={it.at}
                    usage={it.usage}
                    copied={copiedIdx === i}
                    onCopy={() => copyMessage(it.text, i)}
                  />
                </div>
              )
            if (it.kind === 'memory')
              return (
                <div key={i} className="memcard">
                  기억함: {it.ops.map((o) => `${o.title}`).join(' · ')}
                </div>
              )
            if (it.kind === 'notice')
              return (
                <div key={i} className="memcard notice">
                  {it.text}
                </div>
              )
            if (it.kind === 'task') {
              const logOpen = openLogs.has(it.taskId)
              return (
                <div key={i} className="toolcard">
                  <div className="head">
                    <span
                      className={`badge ${
                        it.status === 'done' ? 'done' : it.status === 'cancelled' ? 'aborted' : 'error'
                      }`}
                    >
                      {it.status === 'done' ? '작업 완료' : it.status === 'cancelled' ? '작업 취소됨' : '작업 실패'}
                    </span>
                    <span>{it.title}</span>
                    {it.usage && (
                      <span
                        className="tokens"
                        title="이 작업에서 워커가 사용한 토큰 — 입력 ↑ / 출력 ↓"
                      >
                        ↑{fmtTokens(it.usage.input)} ↓{fmtTokens(it.usage.output)}
                      </span>
                    )}
                    {it.log && it.log.length > 0 && (
                      <button
                        className="loglink"
                        onClick={() =>
                          setOpenLogs((prev) => {
                            const next = new Set(prev)
                            if (next.has(it.taskId)) next.delete(it.taskId)
                            else next.add(it.taskId)
                            return next
                          })
                        }
                      >
                        {logOpen ? '과정 접기' : '과정 보기'}
                      </button>
                    )}
                  </div>
                  {logOpen && it.log && <WorkLog items={it.log} />}
                  {it.result && (
                    <div className="task-result">
                      <Markdown text={it.result} />
                    </div>
                  )}
                </div>
              )
            }
            return <ToolCard key={i} item={it} />
          })}
          <div ref={bottomRef} />
        </div>
        {selPop && (
          <button
            className="selquote-btn"
            style={{ left: selPop.x, top: selPop.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuote(selPop.text)
              setSelPop(null)
              window.getSelection()?.removeAllRanges()
            }}
          >
            ❝ 인용해서 질문
          </button>
        )}
        {runningTasks.length > 0 && (
          <>
            <div className="taskbar">
              {runningTasks.map((t) => (
                <div key={t.id} className="taskchip">
                  <span className="pulse" />
                  {t.tier && <span className="tag">{TIER_LABEL[t.tier]}</span>}
                  <span>
                    {t.title}
                    {t.detail && <span className="detail"> — {t.detail}</span>}
                  </span>
                  <button
                    className="chip-view"
                    onClick={() => setExpandedTaskId(expandedTaskId === t.id ? null : t.id)}
                  >
                    {expandedTaskId === t.id ? '접기' : '보기'}
                  </button>
                  <button className="chip-cancel" onClick={() => void window.api.cancelTask(t.id)}>
                    취소
                  </button>
                </div>
              ))}
            </div>
            {expandedTaskId &&
              (() => {
                const t = runningTasks.find((x) => x.id === expandedTaskId)
                if (!t) return null
                return (
                  <div className="tasklog-panel">
                    <WorkLog items={t.log ?? []} />
                  </div>
                )
              })()}
          </>
        )}
        {error && <div className="error-banner">{error}</div>}
        {quote && (
          <div className="quote-bar">
            <div className="qmark">❝</div>
            <div className="qtext">{quote}</div>
            <button className="chip-cancel" onClick={() => setQuote(null)} title="인용 제거">
              ×
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="attach-bar">
            {pending.map((p, i) => (
              <span key={i} className="attach-chip">
                {p.previewUrl ? <img className="thumb" src={p.previewUrl} alt={p.name} /> : null}
                <span>{p.name}</span>
                <button className="chip-cancel" onClick={() => removePending(i)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button onClick={() => fileInputRef.current?.click()} title="파일 첨부">
            + 파일
          </button>
          <textarea
            value={input}
            placeholder="메시지 입력 (Enter 전송) — 이미지 붙여넣기, 파일 첨부·드롭 가능"
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.items)
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => f !== null)
              if (files.length > 0) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <button className="danger" onClick={() => activeId && void window.api.chatAbort(activeId)}>
              중지
            </button>
          ) : (
            <button className="primary" onClick={send}>
              전송
            </button>
          )}
        </div>
      </div>
    </>
  )
}
