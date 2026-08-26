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
import SidebarResizer from './SidebarResizer'
import { fmtTokens } from '../lib/format'
import { copyText } from '../lib/clipboard'
import { useSidebarPrefs } from '../lib/sidebarPrefs'

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
/** 평문에서 검색어와 일치하는 모든 구간을 <mark>로 감싼다 */
function Marked({ text, query }: { text: string; query?: string }): JSX.Element {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const parts: JSX.Element[] = []
  let from = 0
  let pos = lower.indexOf(q)
  if (pos < 0) return <>{text}</>
  while (pos >= 0) {
    if (pos > from) parts.push(<span key={`t${from}`}>{text.slice(from, pos)}</span>)
    parts.push(<mark key={`m${pos}`}>{text.slice(pos, pos + q.length)}</mark>)
    from = pos + q.length
    pos = lower.indexOf(q, from)
  }
  if (from < text.length) parts.push(<span key={`t${from}`}>{text.slice(from)}</span>)
  return <>{parts}</>
}

const HIT_KIND_LABEL: Record<SessionSearchHit['kind'], string> = {
  title: '제목',
  user: '나',
  assistant: '에이전트',
  task: '작업'
}

const TIER_LABEL: Record<string, string> = { light: '경량', standard: '일반', advanced: '고급' }

const TOOL_STATUS_LABEL: Record<string, string> = {
  running: '실행 중',
  done: '완료',
  denied: '거부됨',
  error: '오류',
  aborted: '중단됨'
}

function ToolCard({
  item,
  idx,
  highlight
}: {
  item: ChatItem & { kind: 'tool' }
  idx?: number
  highlight?: string
}): JSX.Element {
  /* 출력은 접힌 칩이 기본 — 헤더 클릭으로 펼친다 */
  const [open, setOpen] = useState(false)
  const expandable = Boolean(item.output)
  return (
    <div className="toolcard" data-idx={idx}>
      <div
        className={`head ${expandable ? 'clickable' : ''}`}
        onClick={() => expandable && setOpen((v) => !v)}
        title={expandable ? '클릭해 출력 펼치기/접기' : undefined}
      >
        <span className={`badge ${item.status}`}>{TOOL_STATUS_LABEL[item.status]}</span>
        <span>
          <Marked text={item.summary} query={highlight} />
        </span>
        {expandable && <span className="chev">{open ? '▾' : '▸'}</span>}
      </div>
      {open && item.output && <pre>{item.output}</pre>}
    </div>
  )
}

/** 워커(서브 에이전트)의 작업 과정 — 메인 대화처럼 텍스트와 도구 카드를 순서대로 표시 */
function WorkLog({ items, highlight }: { items: ChatItem[]; highlight?: string }): JSX.Element {
  return (
    <div className="worklog">
      {items.length === 0 && <div className="empty">아직 활동이 없습니다.</div>}
      {items.map((it, i) => {
        if (it.kind === 'assistant')
          return (
            <div key={i} className="msg assistant">
              <Markdown text={it.text} highlight={highlight} />
            </div>
          )
        if (it.kind === 'tool') return <ToolCard key={i} item={it} highlight={highlight} />
        return null
      })}
    </div>
  )
}

interface ChatViewProps {
  /** 지식베이스에서 "출처 대화 열기"로 넘어온 대화 */
  jumpSession?: { id: string; nonce: number } | null
  /** 기억 카드에서 지식베이스로 이동 */
  onOpenMemory?: (memoryId: string) => void
}

export default function ChatView({ jumpSession, onOpenMemory }: ChatViewProps = {}): JSX.Element {
  const { prefs, setWidth, commitWidth, resetWidth, toggleHidden, toggleSide } = useSidebarPrefs()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameGuard = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** 응답 대기 중 실시간 진행 상태 — 첫 출력 전/도구 대기 구간을 채운다 */
  const [progress, setProgress] = useState<{ label: string; kind: 'thinking' | 'tool' } | null>(null)
  /** 진행 표시에 곁들일 경과 시간(초) */
  const [elapsed, setElapsed] = useState(0)
  const [runningTasks, setRunningTasks] = useState<TaskInfo[]>([])
  /** 실시간 과정을 펼쳐 보는 진행 중 작업 id */
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  /** 과정을 펼친 완료 작업 카드의 taskId 집합 */
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  /** 방금 복사한 메시지 인덱스 (버튼 피드백용) */
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 다음 전송에 인용으로 첨부할 선택 텍스트 */
  const [quote, setQuote] = useState<string | null>(null)
  /** 대화 기록 검색어 — 입력 중이면 사이드바가 검색 결과 모드로 전환된다 */
  const [search, setSearch] = useState('')
  /** null = 검색 중(디바운스 대기 포함) */
  const [searchHits, setSearchHits] = useState<SessionSearchHit[] | null>(null)
  /**
   * 검색 결과로 이동할 대상. nonce로 같은 항목을 다시 눌러도 반응한다.
   * query는 본문 하이라이트에 쓰이며, 검색을 지울 때까지 남는다.
   */
  const [jump, setJump] = useState<{ idx: number; query: string; nonce: number } | null>(null)
  /** 이미 처리한 jump의 nonce — items가 바뀔 때마다 다시 튀지 않게 한다 */
  const handledJump = useRef(-1)
  const jumpNonce = useRef(0)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** 하단을 따라가는 중인지 — 위를 읽고 있을 때 새 메시지가 끌어내리지 않도록 */
  const stickToBottom = useRef(true)
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

  /** 분할 처리 결과처럼 긴 산출물을 파일로 내보낸다 (저장 위치는 네이티브 대화상자에서 고른다) */
  const saveResult = async (title: string, text: string, taskId: string): Promise<void> => {
    const path = await window.api.saveTaskResult(title, text)
    if (!path) return
    setSavedTaskId(taskId)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSavedTaskId(null), 2000)
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
      // 지식베이스에서 지정해 들어온 대화가 있으면 그것을, 없으면 최근 대화를 연다
      const target = jumpSession && list.some((s) => s.id === jumpSession.id) ? jumpSession.id : list[0]?.id
      if (target) {
        await openSession(target)
      } else {
        const s = await window.api.createSession()
        setSessions([s.meta])
        setActiveId(s.meta.id)
        setItems([])
      }
    })()
    // 마운트 이후 같은 대화를 다시 요청받는 경우까지 nonce로 반응한다
  }, [jumpSession?.nonce])

  // ⌘/Ctrl+B — 사이드바 접기/펼치기 (편집 중에도 동작해야 하므로 입력 필드를 가리지 않는다)
  // e.key는 입력기·자판 배열에 따라 'b'가 아닌 값으로 들어올 수 있어 물리 키(e.code)를 우선 본다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const isB = e.code === 'KeyB' || e.key.toLowerCase() === 'b'
      if (!isB || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      toggleHidden()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleHidden])

  useEffect(() => {
    return window.api.onChatEvent((e) => {
      if (e.sessionId !== activeIdRef.current) return
      if (e.type === 'turn-start') {
        setBusy(true)
        setError(null)
        setProgress({ label: '생각하고 있어요', kind: 'thinking' })
      } else if (e.type === 'text-delta') {
        // 텍스트가 실시간으로 흐르는 동안에는 스트리밍 자체가 진행 표시이므로 인디케이터를 감춘다
        setProgress(null)
        setItems((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.kind === 'assistant') {
            return [...prev.slice(0, -1), { ...last, text: last.text + e.text }]
          }
          return [...prev, { kind: 'assistant', text: e.text, at: new Date().toISOString() }]
        })
      } else if (e.type === 'tool-call') {
        setProgress({ label: e.summary, kind: 'tool' })
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
        // 도구가 끝나면 다음 단계를 준비하는 '생각 중'으로 되돌린다
        setProgress({ label: '생각하고 있어요', kind: 'thinking' })
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
        setProgress(null)
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

  // 입력 내용에 맞춰 composer 높이 자동 조절
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [input])

  // 응답 대기 중 경과 시간 1초마다 갱신 (진행 표시에 곁들인다)
  useEffect(() => {
    if (!busy) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  // 대화 기록 검색 (디바운스)
  useEffect(() => {
    if (!search.trim()) {
      setSearchHits(null)
      setJump(null)
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

  // 검색 결과에서 진입한 경우 해당 항목으로, 그 외에는 (따라가는 중일 때만) 맨 아래로
  useEffect(() => {
    if (jump && handledJump.current !== jump.nonce) {
      handledJump.current = jump.nonce
      // 작업 카드의 일치가 접힌 '과정' 안에 있으면 펼쳐야 보인다
      const target = items[jump.idx]
      if (target?.kind === 'task') {
        const q = jump.query.trim().toLowerCase()
        const inHead =
          target.title.toLowerCase().includes(q) || (target.result ?? '').toLowerCase().includes(q)
        if (!inHead) setOpenLogs((prev) => new Set(prev).add(target.taskId))
      }
      let tries = 0
      let settles = 0
      let timer: ReturnType<typeof setTimeout>
      // 항목이 아직 그려지지 않았을 수 있어 잠깐씩 기다리며 다시 찾는다.
      // (창이 가려져 있으면 rAF가 멈추므로 타이머를 쓴다)
      const run = (): void => {
        const el = messagesRef.current?.querySelector(`[data-idx="${jump.idx}"]`)
        if (!el) {
          if (tries++ < 40) timer = setTimeout(run, 25)
          return
        }
        el.scrollIntoView({ block: 'center' })
        stickToBottom.current = false
        setHighlightIdx(jump.idx)
        if (highlightTimer.current) clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => setHighlightIdx(null), 2000)
        // 카드를 가운데 두는 것으로는 부족하다 — 작업 카드처럼 키가 크면 일치 지점이
        // 화면 밖에 남는다. 일치 표시가 나타나는 대로(과정 로그 펼침 등) 그 지점에 맞춘다.
        const settle = (): void => {
          const mark = el.querySelector('mark')
          if (mark) mark.scrollIntoView({ block: 'center' })
          else if (settles++ < 12) timer = setTimeout(settle, 25)
          else el.scrollIntoView({ block: 'center' })
        }
        timer = setTimeout(settle, 25)
      }
      run()
      return () => clearTimeout(timer)
    }
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    return undefined
  }, [items, jump])

  const openSession = async (id: string, jumpTo?: { idx: number; query: string }): Promise<void> => {
    const s = await window.api.getSession(id)
    if (s) {
      // 점프 대상이 없으면 평소대로 맨 아래에서 시작한다
      stickToBottom.current = !jumpTo
      setJump(jumpTo ? { ...jumpTo, nonce: ++jumpNonce.current } : null)
      setActiveId(id)
      setItems(s.items)
      setError(null)
      setQuote(null)
      setSelPop(null)
      // 버튼 상태를 이벤트가 아닌 실제 실행 여부로 동기화 (세션 전환·이벤트 누락 시 desync 방지)
      const running = await window.api.chatIsRunning(id)
      setBusy(running)
      setProgress(running ? { label: '생각하고 있어요', kind: 'thinking' } : null)
      setRunningTasks((await window.api.listTasks(id)).filter((t) => t.status === 'running'))
    }
  }

  const openHit = async (hit: SessionSearchHit): Promise<void> => {
    await openSession(
      hit.sessionId,
      hit.itemIndex >= 0 ? { idx: hit.itemIndex, query: search } : undefined
    )
  }

  const newSession = async (): Promise<void> => {
    const s = await window.api.createSession()
    await refreshSessions()
    setActiveId(s.meta.id)
    setItems([])
    setBusy(false)
    setProgress(null)
    setRunningTasks([])
  }

  const startRename = (e: React.MouseEvent, s: SessionMeta): void => {
    e.stopPropagation()
    renameGuard.current = false
    setRenamingId(s.id)
    setRenameText(s.title)
  }

  /** Enter/blur는 저장, Escape는 취소. 입력이 사라지며 blur가 뒤따라도 한 번만 처리한다 */
  const finishRename = async (commit: boolean): Promise<void> => {
    if (renameGuard.current) return
    renameGuard.current = true
    const id = renamingId
    const title = renameText.trim()
    setRenamingId(null)
    if (!commit || !id || !title) return
    const updated = await window.api.renameSession(id, title)
    if (updated) setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
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
    // turn-start 이벤트를 기다리지 않고 즉시 진행 표시를 켜 반응 지연을 없앤다
    setProgress({ label: '생각하고 있어요', kind: 'thinking' })
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

  const sideLabel = prefs.side === 'left' ? '오른쪽' : '왼쪽'

  return (
    <div className={`chat-layout ${prefs.side === 'right' ? 'sidebar-right' : ''}`}>
      {prefs.hidden ? (
        <button
          className="sidebar-reveal"
          title="사이드바 표시 (⌘/Ctrl+B)"
          aria-label="사이드바 표시"
          onClick={toggleHidden}
        >
          {prefs.side === 'left' ? '›' : '‹'}
        </button>
      ) : (
        <>
          <div className="sidebar" style={{ width: prefs.width }}>
            <div className="sidebar-head">
              <button
                className="sb-btn"
                title={`사이드바를 ${sideLabel}으로 옮기기`}
                aria-label={`사이드바를 ${sideLabel}으로 옮기기`}
                onClick={toggleSide}
              >
                ⇄
              </button>
              <button
                className="sb-btn"
                title="사이드바 숨기기 (⌘/Ctrl+B)"
                aria-label="사이드바 숨기기"
                onClick={toggleHidden}
              >
                {prefs.side === 'left' ? '‹' : '›'}
              </button>
            </div>
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
                  <Marked text={h.snippet} query={search} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          sessions.map((s) =>
            s.id === renamingId ? (
              <div key={s.id} className="session renaming">
                <input
                  autoFocus
                  value={renameText}
                  maxLength={80}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => void finishRename(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void finishRename(true)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      void finishRename(false)
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={s.id}
                className={`session ${s.id === activeId ? 'active' : ''}`}
                onClick={() => void openSession(s.id)}
                onDoubleClick={(e) => startRename(e, s)}
                title={`${s.title}\n(더블클릭하면 이름을 바꿉니다)`}
              >
                <span>{s.title}</span>
                <button className="rename" title="이름 변경" onClick={(e) => startRename(e, s)}>
                  ✎
                </button>
                <button
                  className="del"
                  title="대화 삭제"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeSession(s.id)
                  }}
                >
                  ×
                </button>
              </div>
            )
          )
        )}
          </div>
          <SidebarResizer
            width={prefs.width}
            side={prefs.side}
            onResize={setWidth}
            onCommit={commitWidth}
            onReset={resetWidth}
          />
        </>
      )}
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
        <div
          className="messages"
          ref={messagesRef}
          onMouseUp={onMessagesMouseUp}
          onScroll={(e) => {
            setSelPop(null)
            const box = e.currentTarget
            stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight <= 120
          }}
        >
          <div className="msg-col">
          {items.length === 0 && (
            <div className="empty">무엇을 도와드릴까요? 파일 정리, 스크립트 실행 등 데스크톱 작업을 요청해 보세요.</div>
          )}
          {items.map((it, i) => {
            // 검색으로 이동해 온 항목에만 본문 하이라이트를 건다
            const hl = jump && jump.idx === i ? jump.query : undefined
            if (it.kind === 'user') {
              const { quote: q, body } = splitLeadingQuote(it.text)
              return (
                <div key={i} data-idx={i} className={`msg-wrap user ${highlightIdx === i ? 'hl' : ''}`}>
                  <div className="msg user">
                    {q && <div className="uquote">{q}</div>}
                    <Marked text={body} query={hl} />
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
                    <Markdown text={it.text} highlight={hl} />
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
                <div key={i} data-idx={i} className={`memcard ${highlightIdx === i ? 'hl' : ''}`}>
                  기억함:{' '}
                  {it.ops.map((o, k) => (
                    <span key={k}>
                      {k > 0 && ' · '}
                      {o.id && onOpenMemory ? (
                        <button className="link" onClick={() => onOpenMemory(o.id as string)}>
                          {o.title}
                        </button>
                      ) : (
                        o.title
                      )}
                    </span>
                  ))}
                </div>
              )
            if (it.kind === 'notice')
              return (
                <div
                  key={i}
                  data-idx={i}
                  className={`memcard notice ${highlightIdx === i ? 'hl' : ''}`}
                >
                  {it.text}
                </div>
              )
            if (it.kind === 'task') {
              const logOpen = openLogs.has(it.taskId)
              return (
                <div
                  key={i}
                  data-idx={i}
                  className={`toolcard task ${highlightIdx === i ? 'hl' : ''}`}
                >
                  <div className="head">
                    <span
                      className={`badge ${
                        it.status === 'done' ? 'done' : it.status === 'cancelled' ? 'aborted' : 'error'
                      }`}
                    >
                      {it.status === 'done' ? '작업 완료' : it.status === 'cancelled' ? '작업 취소됨' : '작업 실패'}
                    </span>
                    <span>
                      <Marked text={it.title} query={hl} />
                    </span>
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
                  {logOpen && it.log && <WorkLog items={it.log} highlight={hl} />}
                  {it.result && (
                    <div className="task-result">
                      <Markdown text={it.result} highlight={hl} />
                      <div className="msg-meta">
                        <button
                          className="copy"
                          title="결과 마크다운 원문 복사"
                          onClick={() => copyMessage(it.result!, i)}
                        >
                          {copiedIdx === i ? '복사됨 ✓' : '복사'}
                        </button>
                        <button
                          className="copy"
                          title="결과를 마크다운 파일로 저장"
                          onClick={() => void saveResult(it.title, it.result!, it.taskId)}
                        >
                          {savedTaskId === it.taskId ? '저장됨 ✓' : '파일로 저장'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            return <ToolCard key={i} item={it} idx={i} highlight={hl} />
          })}
          {busy && progress && (
            <div className="msg-wrap assistant">
              <div className="progress-bubble">
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="plabel">
                  {progress.kind === 'tool' ? `${progress.label} 실행 중` : progress.label}
                </span>
                {elapsed > 0 && <span className="pelapsed">{elapsed}초</span>}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
          </div>
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
        <div className="composer-area">
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
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder="메시지 입력"
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
            <div className="c-row">
              <button className="iconbtn" onClick={() => fileInputRef.current?.click()} title="파일 첨부">
                +
              </button>
              <span className="hint">Enter 전송 · Shift+Enter 줄바꿈 · 이미지 붙여넣기/드롭 가능</span>
              {busy ? (
                <button
                  className="send stop"
                  title="중지"
                  onClick={() => activeId && void window.api.chatAbort(activeId)}
                >
                  ■
                </button>
              ) : (
                <button className="send" title="전송" onClick={send}>
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
