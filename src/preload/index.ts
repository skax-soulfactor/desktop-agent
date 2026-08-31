import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCard,
  ApprovalDecision,
  ApprovalRequest,
  Skill,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  ClarifyRequest,
  InboundRecord,
  McpServerConfig,
  MemoryBulkAction,
  MemoryEntry,
  MemoryReviewItem,
  MemoryStats,
  ModelTier,
  NetworkConfig,
  NotificationRecord,
  Peer,
  PeerPolicy,
  PermissionRule,
  ProviderConfig,
  Schedule,
  SecretMeta,
  SecretRequest,
  SessionMeta,
  SessionSearchHit,
  TaskInfo,
  TierAssignment,
  UpdateStatus,
  UsageRecord
} from '@shared/types'
import type { DesktopAgentApi, NetworkApproval, SessionDataDto } from '@shared/api'

/** renderer에 노출하는 유일한 API — 채널 화이트리스트 역할 */
const api: DesktopAgentApi = {
  chatSend: (sessionId: string, text: string, attachments?: AttachmentPayload[]): Promise<void> =>
    ipcRenderer.invoke('chat:send', sessionId, text, attachments),
  chatAbort: (sessionId: string): Promise<void> => ipcRenderer.invoke('chat:abort', sessionId),
  chatIsRunning: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:isRunning', sessionId),

  listTasks: (sessionId?: string): Promise<TaskInfo[]> => ipcRenderer.invoke('tasks:list', sessionId),
  cancelTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke('tasks:cancel', taskId),
  clarifyRespond: (requestId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke('clarify:respond', requestId, answer),
  clarifyPending: (): Promise<ClarifyRequest[]> => ipcRenderer.invoke('clarify:pending'),
  onClarifyRequest: (cb: (r: ClarifyRequest) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, r: ClarifyRequest): void => cb(r)
    ipcRenderer.on('clarify:request', handler)
    return () => ipcRenderer.removeListener('clarify:request', handler)
  },

  listSchedules: (): Promise<Schedule[]> => ipcRenderer.invoke('schedules:list'),
  deleteSchedule: (id: string): Promise<boolean> => ipcRenderer.invoke('schedules:delete', id),
  toggleSchedule: (id: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('schedules:toggle', id, enabled),
  onChatEvent: (cb: (e: ChatEvent & { sessionId: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: ChatEvent & { sessionId: string }): void => cb(ev)
    ipcRenderer.on('chat:event', handler)
    return () => ipcRenderer.removeListener('chat:event', handler)
  },

  approvalRespond: (requestId: string, decision: ApprovalDecision): Promise<void> =>
    ipcRenderer.invoke('approval:respond', requestId, decision),
  onApprovalRequest: (cb: (r: ApprovalRequest) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, r: ApprovalRequest): void => cb(r)
    ipcRenderer.on('approval:request', handler)
    return () => ipcRenderer.removeListener('approval:request', handler)
  },

  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list'),
  createSession: (): Promise<SessionDataDto> => ipcRenderer.invoke('sessions:create'),
  getSession: (id: string): Promise<SessionDataDto | null> => ipcRenderer.invoke('sessions:get', id),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id: string, title: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('sessions:rename', id, title),
  searchSessions: (query: string): Promise<SessionSearchHit[]> =>
    ipcRenderer.invoke('sessions:search', query),
  listUsage: (from?: string, to?: string): Promise<UsageRecord[]> =>
    ipcRenderer.invoke('usage:list', from, to),

  listProviders: (): Promise<{ providers: ProviderConfig[]; tiers: TierAssignment }> =>
    ipcRenderer.invoke('providers:list'),
  saveProvider: (config: ProviderConfig, apiKey?: string): Promise<void> =>
    ipcRenderer.invoke('providers:save', config, apiKey),
  deleteProvider: (id: string): Promise<void> => ipcRenderer.invoke('providers:delete', id),
  setTier: (tier: ModelTier, providerId: string | null): Promise<void> =>
    ipcRenderer.invoke('providers:setTier', tier, providerId),

  listRules: (): Promise<PermissionRule[]> => ipcRenderer.invoke('rules:list'),
  deleteRule: (id: string): Promise<void> => ipcRenderer.invoke('rules:delete', id),
  listAudit: (): Promise<AuditRecord[]> => ipcRenderer.invoke('audit:list'),
  getElevationEnabled: (): Promise<boolean> => ipcRenderer.invoke('elevation:get'),
  setElevationEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('elevation:set', enabled),

  listMemories: (): Promise<MemoryEntry[]> => ipcRenderer.invoke('memory:list'),
  createMemory: (
    data: Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags'>
  ): Promise<MemoryEntry> => ipcRenderer.invoke('memory:create', data),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  updateMemory: (id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null> =>
    ipcRenderer.invoke('memory:update', id, patch),
  bulkMemory: (ids: string[], action: MemoryBulkAction, tag?: string): Promise<number> =>
    ipcRenderer.invoke('memory:bulk', ids, action, tag),
  mergeMemories: (keepId: string, dropIds: string[]): Promise<MemoryEntry | null> =>
    ipcRenderer.invoke('memory:merge', keepId, dropIds),
  memoryReview: (): Promise<MemoryReviewItem[]> => ipcRenderer.invoke('memory:review'),
  markMemoryReviewed: (id: string): Promise<MemoryEntry | null> =>
    ipcRenderer.invoke('memory:markReviewed', id),
  memoryStats: (): Promise<MemoryStats> => ipcRenderer.invoke('memory:stats'),
  memoryPreview: (query: string): Promise<{ text: string; tokens: number }> =>
    ipcRenderer.invoke('memory:preview', query),
  exportMemories: (format: 'json' | 'md'): Promise<string | null> =>
    ipcRenderer.invoke('memory:export', format),
  importMemories: (): Promise<{ added: number; skipped: number; error?: string } | null> =>
    ipcRenderer.invoke('memory:import'),
  saveTaskResult: (title: string, text: string): Promise<string | null> =>
    ipcRenderer.invoke('task:saveResult', title, text),

  listSkills: (includeArchived?: boolean): Promise<Skill[]> =>
    ipcRenderer.invoke('skill:list', includeArchived),
  saveSkill: (skill: Partial<Skill> & Pick<Skill, 'name' | 'instruction' | 'mode'>): Promise<Skill> =>
    ipcRenderer.invoke('skill:save', skill),
  deleteSkill: (id: string): Promise<boolean> => ipcRenderer.invoke('skill:delete', id),

  netConfig: (): Promise<NetworkConfig> => ipcRenderer.invoke('net:config'),
  netSaveConfig: (patch: Partial<NetworkConfig>): Promise<NetworkConfig> =>
    ipcRenderer.invoke('net:saveConfig', patch),
  netGetCard: (): Promise<AgentCard | null> => ipcRenderer.invoke('net:getCard'),
  netSaveCard: (card: AgentCard): Promise<void> => ipcRenderer.invoke('net:saveCard', card),
  netRegenCard: (): Promise<AgentCard> => ipcRenderer.invoke('net:regenCard'),
  netStartListening: (): Promise<void> => ipcRenderer.invoke('net:startListening'),
  netStopListening: (): Promise<void> => ipcRenderer.invoke('net:stopListening'),
  netListPeers: (): Promise<Peer[]> => ipcRenderer.invoke('net:listPeers'),
  netUpdatePeerPolicy: (id: string, policy: PeerPolicy): Promise<Peer | null> =>
    ipcRenderer.invoke('net:updatePeerPolicy', id, policy),
  netDeletePeer: (id: string): Promise<void> => ipcRenderer.invoke('net:deletePeer', id),
  netFetchCard: (address: string): Promise<AgentCard> => ipcRenderer.invoke('net:fetchCard', address),
  netPair: (address: string): Promise<{ ok: boolean; error?: string; peer?: Peer }> =>
    ipcRenderer.invoke('net:pair', address),
  netRespondApproval: (requestId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('net:respondApproval', requestId, approved),
  netListInbound: (): Promise<InboundRecord[]> => ipcRenderer.invoke('net:listInbound'),
  onNetworkApproval: (cb: (a: NetworkApproval) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, a: NetworkApproval): void => cb(a)
    ipcRenderer.on('network:approval', handler)
    return () => ipcRenderer.removeListener('network:approval', handler)
  },
  onPeersChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('network:peers-changed', handler)
    return () => ipcRenderer.removeListener('network:peers-changed', handler)
  },

  listSecrets: (): Promise<SecretMeta[]> => ipcRenderer.invoke('secrets:list'),
  setSecret: (name: string, value: string): Promise<void> =>
    ipcRenderer.invoke('secrets:set', name, value),
  deleteSecret: (name: string): Promise<void> => ipcRenderer.invoke('secrets:delete', name),
  secretRespond: (requestId: string, value: string | null): Promise<void> =>
    ipcRenderer.invoke('secrets:respond', requestId, value),
  secretPending: (): Promise<SecretRequest[]> => ipcRenderer.invoke('secrets:pending'),
  onSecretRequest: (cb: (r: SecretRequest) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, r: SecretRequest): void => cb(r)
    ipcRenderer.on('secret:request', handler)
    return () => ipcRenderer.removeListener('secret:request', handler)
  },

  mcpList: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:list'),
  mcpSave: (config: McpServerConfig): Promise<void> => ipcRenderer.invoke('mcp:save', config),
  mcpDelete: (id: string): Promise<void> => ipcRenderer.invoke('mcp:delete', id),
  mcpTest: (id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> =>
    ipcRenderer.invoke('mcp:test', id),

  listNotifications: (): Promise<NotificationRecord[]> => ipcRenderer.invoke('notifications:list'),
  markNotificationsRead: (ids?: string[]): Promise<number> =>
    ipcRenderer.invoke('notifications:markRead', ids),
  clearNotifications: (): Promise<void> => ipcRenderer.invoke('notifications:clear'),
  onNotificationsChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('notifications:changed', handler)
    return () => ipcRenderer.removeListener('notifications:changed', handler)
  },

  openNotificationSettings: (): Promise<void> =>
    ipcRenderer.invoke('app:openNotificationSettings'),

  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
