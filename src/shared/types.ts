export type RiskLevel = 'read' | 'write' | 'execute'

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible'

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

export type ChatItem =
  | { kind: 'user'; text: string }
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

export interface AuditRecord {
  at: string
  sessionId: string
  toolName: string
  summary: string
  decision: 'allowed-by-rule' | 'allowed-by-user' | 'denied-by-rule' | 'denied-by-user' | 'blocked'
  result: 'ok' | 'error' | 'denied'
}
