import { useState } from 'react'
import ChatView from './chat/ChatView'
import ApprovalModal from './approval/ApprovalModal'
import SettingsView from './settings/SettingsView'
import MemoryView from './memory/MemoryView'
import SchedulesView from './schedules/SchedulesView'

type Page = 'chat' | 'memory' | 'schedules' | 'settings'

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('chat')

  return (
    <>
      <div className="topnav">
        <span className="brand">Desktop Agent</span>
        <button className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}>
          대화
        </button>
        <button className={page === 'memory' ? 'active' : ''} onClick={() => setPage('memory')}>
          지식베이스
        </button>
        <button className={page === 'schedules' ? 'active' : ''} onClick={() => setPage('schedules')}>
          스케줄
        </button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          설정
        </button>
      </div>
      <div className="layout">
        {page === 'chat' && <ChatView />}
        {page === 'memory' && <MemoryView />}
        {page === 'schedules' && <SchedulesView />}
        {page === 'settings' && <SettingsView />}
      </div>
      <ApprovalModal />
    </>
  )
}
