import { useState } from 'react'
import ChatView from './chat/ChatView'
import ApprovalModal from './approval/ApprovalModal'
import SettingsView from './settings/SettingsView'
import MemoryView from './memory/MemoryView'

type Page = 'chat' | 'memory' | 'settings'

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
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          설정
        </button>
      </div>
      <div className="layout">
        {page === 'chat' && <ChatView />}
        {page === 'memory' && <MemoryView />}
        {page === 'settings' && <SettingsView />}
      </div>
      <ApprovalModal />
    </>
  )
}
