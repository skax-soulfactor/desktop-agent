import { ipcMain, type BrowserWindow } from 'electron'
import type { ApprovalDecision, ProviderConfig } from '@shared/types'
import { runTurn, abortTurn } from './agent/loop'
import { createSession, deleteSession, getSession, listSessions } from './agent/sessions'
import { respondToApproval } from './permissions/gateway'
import { listRules, deleteRule } from './permissions/policies'
import { listAudit } from './permissions/audit'
import { listProviders, saveProvider, deleteProvider, setActiveProvider } from './llm/providers'
import { listMemories, deleteMemory, updateMemory } from './memory/store'

export function registerIpc(getWin: () => BrowserWindow): void {
  // 채팅
  ipcMain.handle('chat:send', (_e, sessionId: string, text: string) => {
    void runTurn(getWin(), sessionId, text)
  })
  ipcMain.handle('chat:abort', (_e, sessionId: string) => abortTurn(sessionId))

  // 승인
  ipcMain.handle('approval:respond', (_e, requestId: string, decision: ApprovalDecision) =>
    respondToApproval(requestId, decision)
  )

  // 세션
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:create', () => createSession())
  ipcMain.handle('sessions:get', (_e, id: string) => getSession(id))
  ipcMain.handle('sessions:delete', (_e, id: string) => deleteSession(id))

  // 프로바이더
  ipcMain.handle('providers:list', () => listProviders())
  ipcMain.handle('providers:save', (_e, config: ProviderConfig, apiKey?: string) =>
    saveProvider(config, apiKey)
  )
  ipcMain.handle('providers:delete', (_e, id: string) => deleteProvider(id))
  ipcMain.handle('providers:setActive', (_e, id: string) => setActiveProvider(id))

  // 권한 규칙 / 감사 로그
  ipcMain.handle('rules:list', () => listRules())
  ipcMain.handle('rules:delete', (_e, id: string) => deleteRule(id))
  ipcMain.handle('audit:list', () => listAudit(100))

  // 지식베이스
  ipcMain.handle('memory:list', () => listMemories(true))
  ipcMain.handle('memory:delete', (_e, id: string) => deleteMemory(id))
  ipcMain.handle('memory:update', (_e, id: string, patch: Record<string, unknown>) =>
    updateMemory(id, patch)
  )
}
