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
  | { kind: 'user'; text: string; attachments?: AttachmentMeta[] }
  | { kind: 'assistant'; text: string }
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
