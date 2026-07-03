import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AuditRecord,
  ChatEvent,
  MemoryEntry,
  PermissionRule,
  ProviderConfig,
  SessionMeta
} from '@shared/types'
import type { DesktopAgentApi, SessionDataDto } from '@shared/api'

/** renderer에 노출하는 유일한 API — 채널 화이트리스트 역할 */
const api: DesktopAgentApi = {
  chatSend: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:send', sessionId, text),
  chatAbort: (sessionId: string): Promise<void> => ipcRenderer.invoke('chat:abort', sessionId),
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

  listProviders: (): Promise<{ providers: ProviderConfig[]; activeId: string | null }> =>
    ipcRenderer.invoke('providers:list'),
  saveProvider: (config: ProviderConfig, apiKey?: string): Promise<void> =>
    ipcRenderer.invoke('providers:save', config, apiKey),
  deleteProvider: (id: string): Promise<void> => ipcRenderer.invoke('providers:delete', id),
  setActiveProvider: (id: string): Promise<void> => ipcRenderer.invoke('providers:setActive', id),

  listRules: (): Promise<PermissionRule[]> => ipcRenderer.invoke('rules:list'),
  deleteRule: (id: string): Promise<void> => ipcRenderer.invoke('rules:delete', id),
  listAudit: (): Promise<AuditRecord[]> => ipcRenderer.invoke('audit:list'),

  listMemories: (): Promise<MemoryEntry[]> => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  updateMemory: (id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null> =>
    ipcRenderer.invoke('memory:update', id, patch)
}

contextBridge.exposeInMainWorld('api', api)
