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

type Page = 'chat' | 'memory' | 'schedules' | 'network' | 'usage' | 'settings'

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('chat')
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.getAppVersion().then(setVersion)
  }, [])

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
      <div className="layout">
        {page === 'chat' && <ChatView />}
        {page === 'memory' && <MemoryView />}
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
