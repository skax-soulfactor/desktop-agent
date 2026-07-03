import { useEffect, useRef, useState } from 'react'
import type { ChatItem, SessionMeta } from '@shared/types'

export default function ChatView(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

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
            return [...prev.slice(0, -1), { kind: 'assistant', text: last.text + e.text }]
          }
          return [...prev, { kind: 'assistant', text: e.text }]
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
      } else if (e.type === 'turn-end') {
        setBusy(false)
        if (e.error) setError(e.error)
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items])

  const openSession = async (id: string): Promise<void> => {
    const s = await window.api.getSession(id)
    if (s) {
      setActiveId(id)
      setItems(s.items)
      setError(null)
      // 버튼 상태를 이벤트가 아닌 실제 실행 여부로 동기화 (세션 전환·이벤트 누락 시 desync 방지)
      setBusy(await window.api.chatIsRunning(id))
    }
  }

  const newSession = async (): Promise<void> => {
    const s = await window.api.createSession()
    await refreshSessions()
    setActiveId(s.meta.id)
    setItems([])
    setBusy(false)
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

  const send = (): void => {
    const text = input.trim()
    if (!text || busy || !activeId) return
    setInput('')
    void window.api.chatSend(activeId, text)
    setItems((prev) => [...prev, { kind: 'user', text }])
    setBusy(true)
  }

  return (
    <>
      <div className="sidebar">
        <button onClick={() => void newSession()}>+ 새 대화</button>
        {sessions.map((s) => (
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
        ))}
      </div>
      <div className="main">
        <div className="messages">
          {items.length === 0 && (
            <div className="empty">무엇을 도와드릴까요? 파일 정리, 스크립트 실행 등 데스크톱 작업을 요청해 보세요.</div>
          )}
          {items.map((it, i) => {
            if (it.kind === 'user') return <div key={i} className="msg user">{it.text}</div>
            if (it.kind === 'assistant') return <div key={i} className="msg assistant">{it.text}</div>
            if (it.kind === 'memory')
              return (
                <div key={i} className="memcard">
                  기억함: {it.ops.map((o) => `${o.title}`).join(' · ')}
                </div>
              )
            return (
              <div key={i} className="toolcard">
                <div className="head">
                  <span className={`badge ${it.status}`}>
                    {it.status === 'running'
                      ? '실행 중'
                      : it.status === 'done'
                        ? '완료'
                        : it.status === 'denied'
                          ? '거부됨'
                          : it.status === 'aborted'
                            ? '중단됨'
                            : '오류'}
                  </span>
                  <span>{it.summary}</span>
                </div>
                {it.output && <pre>{it.output}</pre>}
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="composer">
          <textarea
            value={input}
            placeholder="메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
            onChange={(e) => setInput(e.target.value)}
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
