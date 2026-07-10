export type RiskLevel = 'read' | 'write' | 'execute'

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible'

/** 모델 등급 — 작업 성격에 따라 자동 라우팅된다 */
export type ModelTier = 'light' | 'standard' | 'advanced'

/** 등급별 프로바이더 배정 (프로바이더 id 또는 미지정) */
export type TierAssignment = Record<ModelTier, string | null>

export interface ProviderConfig {
  id: string
  type: ProviderType
  label: string
  model: string
  baseURL?: string
  /** renderer에는 키 원문을 절대 보내지 않고 존재 여부만 알린다 */
  hasKey?: boolean
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** 렌더러 → 메인으로 전송되는 첨부 파일 */
export interface AttachmentPayload {
  name: string
  mimeType: string
  dataBase64: string
}

/** 대화 기록에 남기는 첨부 메타 (본문은 저장하지 않음) */
export interface AttachmentMeta {
  name: string
  mimeType: string
}

export type ChatItem =
  | { kind: 'user'; text: string; at?: string; attachments?: AttachmentMeta[] }
  | { kind: 'assistant'; text: string; at?: string }
  | {
      kind: 'tool'
      toolCallId: string
      toolName: string
      summary: string
      status: 'running' | 'done' | 'denied' | 'error' | 'aborted'
      output?: string
    }
  | { kind: 'memory'; ops: MemoryOpSummary[] }
  /** 사용자에게 알릴 시스템 공지 (예: 기억 저장 실패) */
  | { kind: 'notice'; text: string }
  | {
      kind: 'task'
      taskId: string
      title: string
      status: TaskStatus
      result?: string
      /** 워커의 작업 과정 (도구 호출·중간 텍스트) — 완료 후에도 펼쳐볼 수 있다 */
      log?: ChatItem[]
    }

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** 백그라운드 서브 에이전트(워커)가 수행하는 위임 작업 */
export interface TaskInfo {
  id: string
  sessionId: string
  title: string
  status: TaskStatus
  /** 진행 중 마지막 활동 (예: 실행 중인 도구 요약) */
  detail?: string
  /** 종료 시 결과 요약 */
  result?: string
  /** 워커의 활동 로그 — 진행 중 실시간 갱신 */
  log?: ChatItem[]
  /** 이 작업에 사용된 모델 등급 */
  tier?: ModelTier
  createdAt: string
  finishedAt?: string
}

export interface MemoryOpSummary {
  op: 'create' | 'update' | 'archive'
  type: MemoryType
  title: string
}

export type ChatEvent =
  | { type: 'turn-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; summary: string }
  | { type: 'tool-result'; toolCallId: string; status: 'done' | 'denied' | 'error'; output: string }
  | { type: 'memory-saved'; ops: MemoryOpSummary[] }
  | { type: 'notice'; text: string }
  | { type: 'task-update'; task: TaskInfo }
  /** unresolvedToolCallIds: 턴 종료 시점에 아직 결과가 없는 도구 호출 (중단됨으로 확정) */
  | { type: 'turn-end'; error?: string; unresolvedToolCallIds: string[] }

export interface ApprovalRequest {
  requestId: string
  toolName: string
  summary: string
  risk: RiskLevel
  input: string
  suggestedPattern: string
  lessons: string[]
}

export interface ApprovalDecision {
  action: 'allow' | 'deny'
  scope: 'once' | 'session' | 'always'
  pattern?: string
  reason?: string
}

export interface PermissionRule {
  id: string
  toolName: string
  pattern: string
  action: 'allow' | 'deny'
  scope: 'session' | 'always'
  createdAt: string
}

export type MemoryType = 'user' | 'requirement' | 'lesson' | 'reference'

export interface MemoryEntry {
  id: string
  type: MemoryType
  title: string
  content: string
  tags: string[]
  sourceSessionId: string
  createdAt: string
  updatedAt: string
  lastRecalledAt: string
  status: 'active' | 'archived'
}

export type ScheduleKind = 'once' | 'interval' | 'daily'

/** 예약/주기 작업 — 시간이 되면 워커 서브 에이전트 작업으로 실행된다 */
export interface Schedule {
  id: string
  sessionId: string
  title: string
  /** 워커에게 전달할 자기완결적 지시 */
  instruction: string
  kind: ScheduleKind
  /** kind=once: 실행 시각 (ISO) */
  runAt?: string
  /** kind=interval: 실행 간격 (분) */
  intervalMinutes?: number
  /** kind=daily: 매일 실행 시각 "HH:MM" */
  timeOfDay?: string
  /** 실행에 사용할 모델 등급 */
  tier?: ModelTier
  enabled: boolean
  nextRunAt: string
  lastRunAt?: string
  createdAt: string
}

export interface AuditRecord {
  at: string
  sessionId: string
  toolName: string
  summary: string
  decision: 'allowed-by-rule' | 'allowed-by-user' | 'denied-by-rule' | 'denied-by-user' | 'blocked'
  result: 'ok' | 'error' | 'denied'
}

// ─────────────────────────── 에이전트 네트워크 (A2A) ───────────────────────────

export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
}

/** A2A AgentCard 호환 + 앱 확장 필드 */
export interface AgentCard {
  protocolVersion: string
  name: string
  description: string
  /** 이 에이전트에 도달하는 주소. v1: http://ip:port, v2: relay://host/agentId */
  url: string
  provider?: { organization?: string }
  version: string
  capabilities: { streaming: boolean }
  skills: AgentSkill[]
  ext: {
    agentId: string
    specialtySummary: string
    acceptedTaskTypes: ('question' | 'task')[]
    cardGeneratedAt: string
    /** 자동 갱신에서 보호되는(사용자가 손댄) 필드명 */
    userEditedFields: string[]
    autoUpdate: boolean
  }
}

export type PeerStatus = 'online' | 'offline' | 'unknown'
export type PeerRequestPolicy = 'auto' | 'ask' | 'deny'

export interface PeerPolicy {
  question: PeerRequestPolicy
  task: PeerRequestPolicy
  dailyLimit: number
}

/** 등록된 상대 에이전트 (토큰은 별도 파일에 분리 저장) */
export interface Peer {
  id: string
  name: string
  address: string
  card: AgentCard
  policy: PeerPolicy
  status: PeerStatus
  pairedAt: string
  lastSeenAt?: string
  /** 오늘 이 피어에게 응답한 횟수 (사용량 상한용) */
  usedToday: number
  usageDate: string
}

/** 네트워크 설정 */
export interface NetworkConfig {
  /** 이 에이전트의 고정 id */
  agentId: string
  listenEnabled: boolean
  listenPort: number
  /** v2 중계서버 주소 (설정 시 RelayTransport 사용) */
  relayUrl?: string
}

/** 수신 요청 로그 */
export interface InboundRecord {
  id: string
  at: string
  peerId: string
  peerName: string
  taskType: 'question' | 'task'
  summary: string
  result: 'answered' | 'delegated' | 'denied' | 'error' | 'pending'
}

/** 페어링 요청 (수신측 승인 다이얼로그용) */
export interface PairRequest {
  requestId: string
  requesterCard: AgentCard
  address: string
}

/** 워커가 작업 중 사용자에게 묻는 질문 (human-in-the-loop) */
export interface ClarifyRequest {
  requestId: string
  taskId: string
  taskTitle: string
  question: string
  options?: string[]
}
