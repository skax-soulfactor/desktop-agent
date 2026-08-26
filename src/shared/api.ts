import type {
  AgentCard,
  ApprovalDecision,
  ApprovalRequest,
  Skill,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  ChatItem,
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
  renameSession(id: string, title: string): Promise<SessionMeta | null>
  searchSessions(query: string): Promise<SessionSearchHit[]>
  listUsage(from?: string, to?: string): Promise<UsageRecord[]>

  listProviders(): Promise<{ providers: ProviderConfig[]; tiers: TierAssignment }>
  saveProvider(config: ProviderConfig, apiKey?: string): Promise<void>
  deleteProvider(id: string): Promise<void>
  setTier(tier: ModelTier, providerId: string | null): Promise<void>

  listRules(): Promise<PermissionRule[]>
  deleteRule(id: string): Promise<void>
  listAudit(): Promise<AuditRecord[]>

  // 지식베이스
  listMemories(): Promise<MemoryEntry[]>
  createMemory(
    data: Pick<MemoryEntry, 'type' | 'title' | 'content' | 'tags'>
  ): Promise<MemoryEntry>
  deleteMemory(id: string): Promise<void>
  updateMemory(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null>
  bulkMemory(ids: string[], action: MemoryBulkAction, tag?: string): Promise<number>
  mergeMemories(keepId: string, dropIds: string[]): Promise<MemoryEntry | null>
  memoryReview(): Promise<MemoryReviewItem[]>
  markMemoryReviewed(id: string): Promise<MemoryEntry | null>
  memoryStats(): Promise<MemoryStats>
  /** 지금 이 질문을 보내면 프롬프트에 실제로 들어갈 지식베이스 블록 (회상 이력을 남기지 않음) */
  memoryPreview(query: string): Promise<{ text: string; tokens: number }>
  exportMemories(format: 'json' | 'md'): Promise<string | null>
  importMemories(): Promise<{ added: number; skipped: number; error?: string } | null>

  /** 작업 결과(문서 분할 처리 결과 등)를 파일로 저장. 저장 경로 또는 취소 시 null */
  saveTaskResult(title: string, text: string): Promise<string | null>

  // 스킬 — 반복 작업의 고정된 지시문
  listSkills(includeArchived?: boolean): Promise<Skill[]>
  saveSkill(skill: Partial<Skill> & Pick<Skill, 'name' | 'instruction' | 'mode'>): Promise<Skill>
  deleteSkill(id: string): Promise<boolean>

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

  // 알림 내역
  listNotifications(): Promise<NotificationRecord[]>
  /** ids를 주면 해당 알림만, 없으면 전부 읽음 처리하고 남은 미확인 수를 반환 */
  markNotificationsRead(ids?: string[]): Promise<number>
  clearNotifications(): Promise<void>
  onNotificationsChanged(cb: () => void): () => void

  // OS 알림 설정 화면 열기
  openNotificationSettings(): Promise<void>

  // 앱 버전 / 업데이트
  getAppVersion(): Promise<string>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
