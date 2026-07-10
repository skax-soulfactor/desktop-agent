import type { ToolSet } from 'ai'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { McpServerConfig } from '@shared/types'
import { checkPermission } from '../permissions/gateway'
import { resolveSecrets, resolveSecretsInRecord } from '../secrets/store'
import { getMcpServer, listMcpServers, setMcpLastStatus } from './store'
import type { TurnContext } from '../tools'

interface Connection {
  client: MCPClient
  tools: ToolSet
}

/** 서버별 연결 캐시 — 설정 변경 시 invalidate */
const connections = new Map<string, Connection>()

async function connect(cfg: McpServerConfig): Promise<Connection> {
  const cached = connections.get(cfg.id)
  if (cached) return cached

  let client: MCPClient
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error('stdio MCP 서버에는 command가 필요합니다.')
    client = await createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: cfg.command,
        args: cfg.args,
        env: resolveSecretsInRecord(cfg.env)
      })
    })
  } else {
    if (!cfg.url) throw new Error('http MCP 서버에는 url이 필요합니다.')
    const url = resolveSecrets(cfg.url)
    const headers = resolveSecretsInRecord(cfg.headers)
    try {
      // 최신 표준(Streamable HTTP) 우선
      client = await createMCPClient({ transport: { type: 'http', url, headers } })
    } catch {
      // 구형 SSE 서버 폴백
      client = await createMCPClient({ transport: { type: 'sse', url, headers } })
    }
  }

  const tools = (await client.tools()) as ToolSet
  const conn: Connection = { client, tools }
  connections.set(cfg.id, conn)
  setMcpLastStatus(cfg.id, { ok: true, tools: Object.keys(tools), at: new Date().toISOString() })
  return conn
}

export async function invalidateMcpConnection(id: string): Promise<void> {
  const conn = connections.get(id)
  connections.delete(id)
  if (conn) await conn.client.close().catch(() => undefined)
}

export async function closeAllMcpConnections(): Promise<void> {
  const all = [...connections.values()]
  connections.clear()
  await Promise.allSettled(all.map((c) => c.client.close()))
}

/** 설정 화면·add_mcp_server의 연결 테스트 */
export async function testMcpServer(id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const cfg = getMcpServer(id)
  if (!cfg) return { ok: false, error: '해당 id의 MCP 서버가 없습니다.' }
  await invalidateMcpConnection(id)
  try {
    const conn = await connect(cfg)
    return { ok: true, tools: Object.keys(conn.tools) }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    setMcpLastStatus(id, { ok: false, error, at: new Date().toISOString() })
    return { ok: false, error }
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 활성화된 모든 MCP 서버의 도구를 권한 게이트웨이로 감싸 워커에 노출한다.
 * 연결 실패한 서버는 건너뛰고 lastStatus에 기록한다 (작업 자체를 막지 않는다).
 */
export async function mcpToolsFor(ctx: TurnContext): Promise<ToolSet> {
  const out: ToolSet = {}
  for (const cfg of listMcpServers()) {
    if (!cfg.enabled) continue
    let conn: Connection
    try {
      conn = await connect(cfg)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      setMcpLastStatus(cfg.id, { ok: false, error, at: new Date().toISOString() })
      continue
    }
    for (const [toolName, t] of Object.entries(conn.tools)) {
      const exposed = safeName(`mcp_${cfg.name}_${toolName}`)
      const original = t as { execute?: (input: unknown, options: unknown) => Promise<unknown> }
      out[exposed] = {
        ...t,
        execute: async (input: unknown, options: unknown) => {
          const summary = `MCP ${cfg.name}: ${toolName}`
          const gate = await checkPermission(ctx.win, {
            sessionId: ctx.sessionId,
            toolName: 'mcp',
            risk: 'execute',
            summary,
            target: `${cfg.name}:${toolName}`,
            suggestedPattern: `${cfg.name}:*`,
            inputJson: JSON.stringify(input, null, 2)
          })
          if (!gate.allowed) {
            ctx.failures.push({ kind: 'approval-denied', detail: `${summary} — ${gate.reason}` })
            return { denied: true, reason: gate.reason }
          }
          try {
            return await original.execute?.(input, options)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            ctx.failures.push({ kind: 'tool-error', detail: `${summary} — ${msg}` })
            return { error: msg }
          }
        }
      } as ToolSet[string]
    }
  }
  return out
}
