import { useEffect, useState } from 'react'
import ChatView from './chat/ChatView'
import ApprovalModal from './approval/ApprovalModal'
import SettingsView from './settings/SettingsView'
import MemoryView from './memory/MemoryView'
import SkillsView from './skills/SkillsView'
import SchedulesView from './schedules/SchedulesView'
import NetworkView from './network/NetworkView'
import UsageView from './usage/UsageView'
import NotificationsView from './notifications/NotificationsView'
import NetworkApprovalModal from './network/NetworkApprovalModal'
import ClarifyModal from './clarify/ClarifyModal'
import SecretModal from './secrets/SecretModal'
import NotifyHint from './NotifyHint'

type Page = 'chat' | 'memory' | 'skills' | 'schedules' | 'network' | 'usage' | 'notifications' | 'settings'

/** 탭 간 이동 요청. nonce는 같은 대상을 연속으로 요청해도 반응하게 하는 값 */
interface Jump {
  id: string
  nonce: number
}

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('chat')
  const [version, setVersion] = useState('')
  /** 지식베이스 → 대화: 기억의 출처 대화 열기 */
  const [jumpSession, setJumpSession] = useState<Jump | null>(null)
  /** 대화 → 지식베이스: 방금 저장된 기억 열기 */
  const [jumpMemory, setJumpMemory] = useState<Jump | null>(null)
  /** 알림 탭 배지에 쓰는 미확인 알림 수 */
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    void window.api.getAppVersion().then(setVersion)
  }, [])

  // 미확인 알림 수는 새 알림이 올 때와 알림 화면을 벗어날 때 바뀐다
  useEffect(() => {
    const refresh = async (): Promise<void> => {
      const list = await window.api.listNotifications()
      setUnread(list.filter((n) => !n.read).length)
    }
    void refresh()
    return window.api.onNotificationsChanged(() => void refresh())
  }, [page])

  /** 지식베이스·알림에서 관련 대화 열기 */
  const openSession = (sessionId: string): void => {
    setJumpSession({ id: sessionId, nonce: Date.now() })
    setPage('chat')
  }

  const openMemoryFromChat = (memoryId: string): void => {
    setJumpMemory({ id: memoryId, nonce: Date.now() })
    setPage('memory')
  }

  return (
    <>
      <div className="topnav">
        <span className="brand">
          Desktop Agent
          {version && <span className="ver">v{version}</span>}
        </span>
        <button className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}>
          대화
        </button>
        <button className={page === 'memory' ? 'active' : ''} onClick={() => setPage('memory')}>
          지식베이스
        </button>
        <button className={page === 'skills' ? 'active' : ''} onClick={() => setPage('skills')}>
          스킬
        </button>
        <button className={page === 'schedules' ? 'active' : ''} onClick={() => setPage('schedules')}>
          스케줄
        </button>
        <button className={page === 'network' ? 'active' : ''} onClick={() => setPage('network')}>
          네트워크
        </button>
        <button className={page === 'usage' ? 'active' : ''} onClick={() => setPage('usage')}>
          사용량
        </button>
        <button
          className={page === 'notifications' ? 'active' : ''}
          onClick={() => setPage('notifications')}
        >
          알림
          {unread > 0 && <span className="nav-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          설정
        </button>
      </div>
      <NotifyHint onOpenNotifications={() => setPage('notifications')} />
      <div className="layout">
        {page === 'chat' && (
          <ChatView jumpSession={jumpSession} onOpenMemory={openMemoryFromChat} />
        )}
        {page === 'memory' && (
          <MemoryView focusId={jumpMemory?.id ?? null} onOpenSession={openSession} />
        )}
        {page === 'skills' && <SkillsView />}
        {page === 'schedules' && <SchedulesView />}
        {page === 'network' && <NetworkView />}
        {page === 'usage' && <UsageView />}
        {page === 'notifications' && (
          <NotificationsView
            onOpenSession={openSession}
            onReadStateChange={() => setUnread(0)}
          />
        )}
        {page === 'settings' && <SettingsView />}
      </div>
      <ApprovalModal />
      <NetworkApprovalModal />
      <ClarifyModal />
      <SecretModal />
    </>
  )
}
