import { useEffect, useRef, useState } from 'react'
import type { NotificationKind, NotificationRecord } from '@shared/types'
import { canOpenNotificationSettings } from '../lib/platform'

const KIND_LABEL: Record<NotificationKind, string> = {
  task: '작업',
  question: '질문',
  approval: '승인 요청',
  secret: '시크릿 요청',
  system: '알림'
}

const KIND_ICON: Record<NotificationKind, string> = {
  task: '✅',
  question: '❓',
  approval: '🔐',
  secret: '🔑',
  system: '🔔'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString() : d.toLocaleString()
}

interface Props {
  /** 작업 알림에서 해당 대화로 이동 */
  onOpenSession: (sessionId: string) => void
  /** 읽음 상태가 바뀌어 상단 탭 배지를 갱신해야 할 때 (화면을 벗어난 뒤에도 호출된다) */
  onReadStateChange: () => void
}

/**
 * 알림 내역 화면.
 * OS 알림이 꺼져 있거나 앱을 보고 있어서 표시되지 않은 건까지 모두 남으므로,
 * 놓친 알림을 나중에 확인할 수 있다. OS 알림 설정은 언제든 여기서 열 수 있다.
 */
export default function NotificationsView({ onOpenSession, onReadStateChange }: Props): JSX.Element {
  const [items, setItems] = useState<NotificationRecord[]>([])
  const [onlyUnread, setOnlyUnread] = useState(false)
  /** 화면에 들어온 시점의 미확인 목록 — 보는 동안 "신규" 구분이 사라지지 않게 고정한다 */
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())

  const refresh = async (): Promise<void> => {
    const list = await window.api.listNotifications()
    setItems(list)
    setFreshIds((prev) => {
      const next = new Set(prev)
      for (const n of list) if (!n.read) next.add(n.id)
      return next
    })
  }

  useEffect(() => {
    void refresh()
    return window.api.onNotificationsChanged(() => void refresh())
  }, [])

  // 화면을 벗어날 때 읽음 처리 — 보는 동안에는 신규 표시가 유지된다
  const notifyRead = useRef(onReadStateChange)
  notifyRead.current = onReadStateChange
  useEffect(() => {
    return () => {
      void window.api.markNotificationsRead().then(() => notifyRead.current())
    }
  }, [])

  const markAllRead = async (): Promise<void> => {
    await window.api.markNotificationsRead()
    setFreshIds(new Set())
    onReadStateChange()
    await refresh()
  }

  const clearAll = async (): Promise<void> => {
    if (!confirm('알림 내역을 모두 지울까요? 되돌릴 수 없습니다.')) return
    await window.api.clearNotifications()
    setFreshIds(new Set())
    onReadStateChange()
    await refresh()
  }

  const unread = items.filter((n) => !n.read).length
  const shown = onlyUnread ? items.filter((n) => freshIds.has(n.id)) : items
  const fresh = shown.filter((n) => freshIds.has(n.id))
  const past = shown.filter((n) => !freshIds.has(n.id))

  const row = (n: NotificationRecord): JSX.Element => (
    <div className={`notif-row${freshIds.has(n.id) ? ' fresh' : ''}`} key={n.id}>
      <span className="ic" aria-hidden="true">
        {KIND_ICON[n.kind] ?? KIND_ICON.system}
      </span>
      <div className="body">
        <div className="head">
          <span className="kind">{KIND_LABEL[n.kind] ?? KIND_LABEL.system}</span>
          <span className="title">{n.title}</span>
          {!n.delivered && (
            <span className="undelivered" title="앱을 보고 있었거나 OS 알림이 표시되지 않았습니다">
              미표시
            </span>
          )}
          <span className="at">{fmtTime(n.at)}</span>
        </div>
        {n.body && <div className="text">{n.body}</div>}
        {n.sessionId && (
          <button className="link" onClick={() => onOpenSession(n.sessionId as string)}>
            대화 열기
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="page">
      <h2>알림</h2>

      <div className="card notif-settings">
        <div className="txt">
          백그라운드 작업 완료, 승인·질문 요청을 OS 알림으로 받습니다. 알림이 오지 않는다면 시스템
          설정에서 이 앱의 알림이 허용되어 있는지 확인하세요. 표시되지 않은 알림도 아래 내역에는 모두
          남습니다.
        </div>
        {canOpenNotificationSettings && (
          <button className="primary" onClick={() => void window.api.openNotificationSettings()}>
            알림 설정 열기
          </button>
        )}
      </div>

      <div className="notif-toolbar">
        <span className="dim">
          전체 {items.length}건{unread > 0 ? ` · 미확인 ${unread}건` : ''}
        </span>
        <label className="dim">
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(e) => setOnlyUnread(e.target.checked)}
          />{' '}
          신규만 보기
        </label>
        <span className="spacer" />
        <button onClick={() => void markAllRead()} disabled={unread === 0}>
          모두 읽음
        </button>
        <button className="danger" onClick={() => void clearAll()} disabled={items.length === 0}>
          내역 지우기
        </button>
      </div>

      {items.length === 0 && <div className="empty">아직 받은 알림이 없습니다.</div>}
      {items.length > 0 && shown.length === 0 && <div className="empty">신규 알림이 없습니다.</div>}

      {fresh.length > 0 && (
        <div>
          <h3>신규 ({fresh.length})</h3>
          <div className="card notif-list">{fresh.map(row)}</div>
        </div>
      )}
      {past.length > 0 && (
        <div>
          <h3>지난 알림 ({past.length})</h3>
          <div className="card notif-list">{past.map(row)}</div>
        </div>
      )}
    </div>
  )
}
