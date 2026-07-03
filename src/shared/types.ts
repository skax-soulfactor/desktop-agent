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
