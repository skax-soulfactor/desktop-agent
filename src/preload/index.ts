import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCard,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  InboundRecord,
  MemoryEntry,
  ModelTier,
  NetworkConfig,
  Peer,
  PeerPolicy,
  PermissionRule,
  ProviderConfig,
  Schedule,
  SessionMeta,
  TaskInfo,
  TierAssignment
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

  listMemories: (): Promise<MemoryEntry[]> => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  updateMemory: (id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null> =>
    ipcRenderer.invoke('memory:update', id, patch),

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
  }
}

contextBridge.exposeInMainWorld('api', api)
