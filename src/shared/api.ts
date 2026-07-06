import type {
  ApprovalDecision,
  ApprovalRequest,
  AttachmentPayload,
  AuditRecord,
  ChatEvent,
  ChatItem,
  MemoryEntry,
  ModelTier,
  PermissionRule,
  ProviderConfig,
  Schedule,
  SessionMeta,
  TaskInfo,
  TierAssignment
} from './types'

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
}
