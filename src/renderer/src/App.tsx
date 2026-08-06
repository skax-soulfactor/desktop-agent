import { useEffect, useState } from 'react'
import ChatView from './chat/ChatView'
import ApprovalModal from './approval/ApprovalModal'
import SettingsView from './settings/SettingsView'
import MemoryView from './memory/MemoryView'
import SchedulesView from './schedules/SchedulesView'
import NetworkView from './network/NetworkView'
import UsageView from './usage/UsageView'
import NetworkApprovalModal from './network/NetworkApprovalModal'
import ClarifyModal from './clarify/ClarifyModal'
import SecretModal from './secrets/SecretModal'
import NotifyHint from './NotifyHint'

type Page = 'chat' | 'memory' | 'schedules' | 'network' | 'usage' | 'settings'

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

  useEffect(() => {
    void window.api.getAppVersion().then(setVersion)
  }, [])

  const openSessionFromMemory = (sessionId: string): void => {
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
        <button className={page === 'schedules' ? 'active' : ''} onClick={() => setPage('schedules')}>
          스케줄
        </button>
        <button className={page === 'network' ? 'active' : ''} onClick={() => setPage('network')}>
          네트워크
        </button>
        <button className={page === 'usage' ? 'active' : ''} onClick={() => setPage('usage')}>
          사용량
        </button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          설정
        </button>
      </div>
      <NotifyHint />
      <div className="layout">
        {page === 'chat' && (
          <ChatView jumpSession={jumpSession} onOpenMemory={openMemoryFromChat} />
        )}
        {page === 'memory' && (
          <MemoryView focusId={jumpMemory?.id ?? null} onOpenSession={openSessionFromMemory} />
        )}
        {page === 'schedules' && <SchedulesView />}
        {page === 'network' && <NetworkView />}
        {page === 'usage' && <UsageView />}
        {page === 'settings' && <SettingsView />}
      </div>
      <ApprovalModal />
      <NetworkApprovalModal />
      <ClarifyModal />
      <SecretModal />
    </>
  )
}
