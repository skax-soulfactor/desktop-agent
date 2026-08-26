import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type { ApprovalDecision, AttachmentPayload, ProviderConfig } from '@shared/types'
import { runTurn, abortTurn, isTurnRunning, currentMemoryBudget } from './agent/loop'
import { listTasks, cancelTask } from './agent/tasks'
import { respondClarify, pendingClarifications } from './agent/clarify'
import { listSchedules, deleteSchedule, setScheduleEnabled } from './agent/scheduler'
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  searchSessions
} from './agent/sessions'
import { respondToApproval } from './permissions/gateway'
import { listRules, deleteRule } from './permissions/policies'
import { listAudit } from './permissions/audit'
import { listProviders, saveProvider, deleteProvider, setTier } from './llm/providers'
import type { ModelTier } from '@shared/types'
import {
  listMemories,
  createMemory,
  deleteMemory,
  updateMemory,
  bulkUpdate,
  mergeMemories,
  markReviewed,
  needsReview,
  memoryStats,
  estimateTokens,
  exportMemories,
  exportMarkdown,
  importMemories
} from './memory/store'
import { buildMemoryContext } from './memory/recall'
import type { MemoryBulkAction, MemoryEntry } from '@shared/types'
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
import { listSecrets, setSecret, deleteSecret } from './secrets/store'
import { respondSecretRequest, pendingSecretRequests } from './secrets/request'
import { listUsage } from './usage/store'
import { listMcpServers, saveMcpServer, deleteMcpServer } from './mcp/store'
import { testMcpServer, invalidateMcpConnection } from './mcp/manager'
import type { McpServerConfig } from '@shared/types'
import { getAppVersion, getUpdateStatus, checkForUpdatesManual, quitAndInstall } from './update'
import {
  listNotifications,
  markNotificationsRead,
  clearNotifications
} from './notifications/store'
import { refreshBadge } from './notify'

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
  ipcMain.handle('clarify:respond', (_e, requestId: string, answer: string) =>
    respondClarify(requestId, answer)
  )
  ipcMain.handle('clarify:pending', () => pendingClarifications())

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
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => renameSession(id, title))
  ipcMain.handle('sessions:search', (_e, query: string) => searchSessions(query))

  // 토큰 사용량
  ipcMain.handle('usage:list', (_e, from?: string, to?: string) => listUsage(from, to))

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
  ipcMain.handle(
    'memory:create',
    (_e, data: Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags'>) =>
      createMemory({ ...data, sourceSessionId: '', origin: 'user' })
  )
  ipcMain.handle('memory:delete', (_e, id: string) => deleteMemory(id))
  ipcMain.handle('memory:update', (_e, id: string, patch: Record<string, unknown>) =>
    updateMemory(id, patch)
  )
  ipcMain.handle('memory:bulk', (_e, ids: string[], action: MemoryBulkAction, tag?: string) =>
    bulkUpdate(ids, action, tag)
  )
  ipcMain.handle('memory:merge', (_e, keepId: string, dropIds: string[]) =>
    mergeMemories(keepId, dropIds)
  )
  ipcMain.handle('memory:review', () => needsReview())
  ipcMain.handle('memory:markReviewed', (_e, id: string) => markReviewed(id))
  // 빈 질의로 만든 블록 = 검색과 무관하게 매 턴 항상 들어가는 고정 비용.
  // 예산은 실제 턴에서 쓰인 값을 그대로 적용한다 — 로컬 모델에서는 여기가 크게 줄어든다.
  ipcMain.handle('memory:stats', () =>
    memoryStats(buildMemoryContext('', { dryRun: true, budgetTokens: currentMemoryBudget() }))
  )
  ipcMain.handle('memory:preview', (_e, query: string) => {
    const text = buildMemoryContext(query, { dryRun: true, budgetTokens: currentMemoryBudget() })
    return { text, tokens: estimateTokens(text) }
  })
  ipcMain.handle('memory:export', async (_e, format: 'json' | 'md') => {
    const stamp = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await dialog.showSaveDialog(getWin(), {
      title: '지식베이스 내보내기',
      defaultPath: `knowledge-base-${stamp}.${format}`,
      filters:
        format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || !filePath) return null
    const body =
      format === 'json' ? JSON.stringify(exportMemories(), null, 2) : exportMarkdown()
    writeFileSync(filePath, body, 'utf-8')
    return filePath
  })
  // 분할 처리 결과처럼 대화에 담기엔 큰 산출물을 사용자가 파일로 가져갈 수 있게 한다
  ipcMain.handle('task:saveResult', async (_e, title: string, text: string) => {
    const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || 'result'
    const { canceled, filePath } = await dialog.showSaveDialog(getWin(), {
      title: '작업 결과 저장',
      defaultPath: `${safe}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '텍스트', extensions: ['txt'] }
      ]
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, text, 'utf-8')
    return filePath
  })
  ipcMain.handle('memory:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: '지식베이스 가져오기',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || filePaths.length === 0) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePaths[0], 'utf-8'))
      if (!Array.isArray(parsed)) return { added: 0, skipped: 0, error: 'JSON 배열이 아닙니다.' }
      return importMemories(parsed as MemoryEntry[])
    } catch (e) {
      return { added: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

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

  // 연동 시크릿 — 값은 renderer로 절대 반환하지 않는다 (이름 목록만)
  ipcMain.handle('secrets:list', () => listSecrets())
  ipcMain.handle('secrets:set', (_e, name: string, value: string) => setSecret(name, value))
  ipcMain.handle('secrets:delete', (_e, name: string) => deleteSecret(name))
  ipcMain.handle('secrets:respond', (_e, requestId: string, value: string | null) =>
    respondSecretRequest(requestId, value)
  )
  ipcMain.handle('secrets:pending', () => pendingSecretRequests())

  // MCP 서버
  ipcMain.handle('mcp:list', () => listMcpServers())
  ipcMain.handle('mcp:save', async (_e, config: McpServerConfig) => {
    saveMcpServer(config)
    await invalidateMcpConnection(config.id)
  })
  ipcMain.handle('mcp:delete', async (_e, id: string) => {
    deleteMcpServer(id)
    await invalidateMcpConnection(id)
  })
  ipcMain.handle('mcp:test', (_e, id: string) => testMcpServer(id))

  // 알림 내역 — OS 알림이 꺼져 있어 놓친 건도 여기서 확인할 수 있다
  ipcMain.handle('notifications:list', () => listNotifications())
  ipcMain.handle('notifications:markRead', (_e, ids?: string[]) => {
    const left = markNotificationsRead(ids)
    refreshBadge()
    return left
  })
  ipcMain.handle('notifications:clear', () => {
    clearNotifications()
    refreshBadge()
  })

  // OS 알림 설정 화면 열기 (사용자가 알림을 켜도록 안내)
  ipcMain.handle('app:openNotificationSettings', () => {
    if (process.platform === 'darwin') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications')
    } else if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:notifications')
    }
  })

  // 앱 버전 / 업데이트
  ipcMain.handle('app:version', () => getAppVersion())
  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdatesManual())
  ipcMain.handle('update:install', () => quitAndInstall())
}
