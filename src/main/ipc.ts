import { ipcMain, type BrowserWindow } from 'electron'
import type { ApprovalDecision, AttachmentPayload, ProviderConfig } from '@shared/types'
import { runTurn, abortTurn, isTurnRunning } from './agent/loop'
import { listTasks, cancelTask } from './agent/tasks'
import { listSchedules, deleteSchedule, setScheduleEnabled } from './agent/scheduler'
import { createSession, deleteSession, getSession, listSessions } from './agent/sessions'
import { respondToApproval } from './permissions/gateway'
import { listRules, deleteRule } from './permissions/policies'
import { listAudit } from './permissions/audit'
import { listProviders, saveProvider, deleteProvider, setTier } from './llm/providers'
import type { ModelTier } from '@shared/types'
import { listMemories, deleteMemory, updateMemory } from './memory/store'
import type { AgentCard, NetworkConfig, PeerPolicy } from '@shared/types'
import {
  getNetworkConfig,
  saveNetworkConfig,
  getMyCard,
  saveMyCard,
  listPeers,
  updatePeer,
  deletePeer,
  listInbound
} from './network/store'
import { regenerateCard } from './network/card'
import {
  startListening,
  stopListening,
  fetchCardPreview,
  pairWithAddress,
  respondNetworkApproval
} from './network/manager'

export function registerIpc(getWin: () => BrowserWindow): void {
  // 채팅
  ipcMain.handle('chat:send', (_e, sessionId: string, text: string, attachments?: AttachmentPayload[]) => {
    void runTurn(getWin(), sessionId, text, attachments ?? [])
  })
  ipcMain.handle('chat:abort', (_e, sessionId: string) => abortTurn(sessionId))
  ipcMain.handle('chat:isRunning', (_e, sessionId: string) => isTurnRunning(sessionId))

  // 백그라운드 작업 (서브 에이전트)
  ipcMain.handle('tasks:list', (_e, sessionId?: string) => listTasks(sessionId))
  ipcMain.handle('tasks:cancel', (_e, taskId: string) => cancelTask(taskId))

  // 예약/주기 작업
  ipcMain.handle('schedules:list', () => listSchedules())
  ipcMain.handle('schedules:delete', (_e, id: string) => deleteSchedule(id))
  ipcMain.handle('schedules:toggle', (_e, id: string, enabled: boolean) => setScheduleEnabled(id, enabled))

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
  ipcMain.handle('providers:setTier', (_e, tier: ModelTier, providerId: string | null) =>
    setTier(tier, providerId)
  )

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

  // 에이전트 네트워크
  ipcMain.handle('net:config', () => getNetworkConfig())
  ipcMain.handle('net:saveConfig', (_e, patch: Partial<NetworkConfig>) => saveNetworkConfig(patch))
  ipcMain.handle('net:getCard', () => getMyCard())
  ipcMain.handle('net:saveCard', (_e, card: AgentCard) => saveMyCard(card))
  ipcMain.handle('net:regenCard', () => regenerateCard())
  ipcMain.handle('net:startListening', () => startListening())
  ipcMain.handle('net:stopListening', () => stopListening())
  ipcMain.handle('net:listPeers', () => listPeers())
  ipcMain.handle('net:updatePeerPolicy', (_e, id: string, policy: PeerPolicy) =>
    updatePeer(id, { policy })
  )
  ipcMain.handle('net:deletePeer', (_e, id: string) => deletePeer(id))
  ipcMain.handle('net:fetchCard', (_e, address: string) => fetchCardPreview(address))
  ipcMain.handle('net:pair', (_e, address: string) => pairWithAddress(address))
  ipcMain.handle('net:respondApproval', (_e, requestId: string, approved: boolean) =>
    respondNetworkApproval(requestId, approved)
  )
  ipcMain.handle('net:listInbound', () => listInbound(100))
}
