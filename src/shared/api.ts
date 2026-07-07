import type {
  AgentCard,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  ChatItem,
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
} from './types'

export interface NetworkApproval {
  requestId: string
  kind: 'pair' | 'task'
  title: string
  detail: string
}

export interface SessionDataDto {
  meta: SessionMeta
  items: ChatItem[]
}

/** preload가 구현하고 renderer가 window.api로 사용하는 계약 */
export interface DesktopAgentApi {
  chatSend(sessionId: string, text: string, attachments?: AttachmentPayload[]): Promise<void>
  chatAbort(sessionId: string): Promise<void>
  chatIsRunning(sessionId: string): Promise<boolean>

  listTasks(sessionId?: string): Promise<TaskInfo[]>
  cancelTask(taskId: string): Promise<boolean>

  listSchedules(): Promise<Schedule[]>
  deleteSchedule(id: string): Promise<boolean>
  toggleSchedule(id: string, enabled: boolean): Promise<boolean>
  onChatEvent(cb: (e: ChatEvent & { sessionId: string }) => void): () => void

  approvalRespond(requestId: string, decision: ApprovalDecision): Promise<void>
  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void

  listSessions(): Promise<SessionMeta[]>
  createSession(): Promise<SessionDataDto>
  getSession(id: string): Promise<SessionDataDto | null>
  deleteSession(id: string): Promise<void>

  listProviders(): Promise<{ providers: ProviderConfig[]; tiers: TierAssignment }>
  saveProvider(config: ProviderConfig, apiKey?: string): Promise<void>
  deleteProvider(id: string): Promise<void>
  setTier(tier: ModelTier, providerId: string | null): Promise<void>

  listRules(): Promise<PermissionRule[]>
  deleteRule(id: string): Promise<void>
  listAudit(): Promise<AuditRecord[]>

  listMemories(): Promise<MemoryEntry[]>
  deleteMemory(id: string): Promise<void>
  updateMemory(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null>

  // 에이전트 네트워크
  netConfig(): Promise<NetworkConfig>
  netSaveConfig(patch: Partial<NetworkConfig>): Promise<NetworkConfig>
  netGetCard(): Promise<AgentCard | null>
  netSaveCard(card: AgentCard): Promise<void>
  netRegenCard(): Promise<AgentCard>
  netStartListening(): Promise<void>
  netStopListening(): Promise<void>
  netListPeers(): Promise<Peer[]>
  netUpdatePeerPolicy(id: string, policy: PeerPolicy): Promise<Peer | null>
  netDeletePeer(id: string): Promise<void>
  netFetchCard(address: string): Promise<AgentCard>
  netPair(address: string): Promise<{ ok: boolean; error?: string; peer?: Peer }>
  netRespondApproval(requestId: string, approved: boolean): Promise<void>
  netListInbound(): Promise<InboundRecord[]>
  onNetworkApproval(cb: (a: NetworkApproval) => void): () => void
  onPeersChanged(cb: () => void): () => void
}
