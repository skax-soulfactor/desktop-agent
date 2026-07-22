import type {
  AgentCard,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  ChatItem,
  ClarifyRequest,
  InboundRecord,
  McpServerConfig,
  MemoryEntry,
  ModelTier,
  NetworkConfig,
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
  clarifyRespond(requestId: string, answer: string): Promise<void>
  clarifyPending(): Promise<ClarifyRequest[]>
  onClarifyRequest(cb: (r: ClarifyRequest) => void): () => void

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
  searchSessions(query: string): Promise<SessionSearchHit[]>
  listUsage(from?: string, to?: string): Promise<UsageRecord[]>

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

  // 연동 시크릿 (값은 renderer로 오지 않음)
  listSecrets(): Promise<SecretMeta[]>
  setSecret(name: string, value: string): Promise<void>
  deleteSecret(name: string): Promise<void>
  secretRespond(requestId: string, value: string | null): Promise<void>
  secretPending(): Promise<SecretRequest[]>
  onSecretRequest(cb: (r: SecretRequest) => void): () => void

  // MCP 서버
  mcpList(): Promise<McpServerConfig[]>
  mcpSave(config: McpServerConfig): Promise<void>
  mcpDelete(id: string): Promise<void>
  mcpTest(id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }>

  // 앱 버전 / 업데이트
  getAppVersion(): Promise<string>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
