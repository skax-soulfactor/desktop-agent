import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { McpServerConfig } from '@shared/types'
import { checkPermission } from '../permissions/gateway'
import { capToolResult, PURPOSE_FIELD, type TurnContext } from '../tools'
import { connectMcp } from './manager'
import { listMcpServers, setMcpLastStatus } from './store'

/**
 * 검색 MCP 서버를 대화 에이전트의 web_search 도구 하나로 묶는 라우터.
 *
 * 등록된 MCP 도구를 전부 대화에 노출하지 않는 이유는 두 가지다. 하나는 프롬프트 크기 —
 * 노션 MCP 하나만 붙여도 도구가 스무 개씩 늘어난다. 다른 하나는 이름 — 검색 도구 이름은
 * 서버마다 다르고(brave_web_search / tavily-search / web_search_exa) 프롬프트에 고정할 수 없다.
 * 이름이 고정되지 않으면 "검색이 필요하면 X를 불러라"라고 쓸 수가 없다.
 *
 * 그래서 어느 서버를 붙이든 대화 쪽에서는 web_search 하나로 보이게 한다.
 * 확인된 서버들의 검색 도구는 모두 query: string 하나로 호출된다.
 */

/** 검색 도구로 볼 이름 */
const SEARCH_TOOL = /search/i

/** 아직 한 번도 연결해 본 적 없는 서버는 이름으로 짐작한다 */
const SEARCH_NAME = /search|tavily|brave|exa|perplexity|serper|duckduckgo|kagi/i

/** 연결에 실패한 서버를 매 턴 다시 붙잡지 않는다 (대화가 그만큼 느려진다) */
const RETRY_AFTER_MS = 5 * 60 * 1000

/**
 * 검색 도구를 고른다. 이미지·뉴스·지역 검색보다 웹 검색을 우선한다 —
 * 예: 브레이브는 brave_web_search 외에 image/news/local/video 검색을 함께 노출한다.
 */
function pickSearchTool(names: string[]): string | undefined {
  return (
    names.find((n) => /web/i.test(n) && SEARCH_TOOL.test(n)) ?? names.find((n) => SEARCH_TOOL.test(n))
  )
}

/**
 * 검색에 쓸 서버를 고른다. 연결하지 않고 저장된 연결 이력(lastStatus.tools)만 본다 —
 * 매 턴 모든 MCP 서버에 접속하면(스토리오 서버는 프로세스를 띄운다) 대화가 그만큼 늦어진다.
 */
export function findSearchServer(): { cfg: McpServerConfig; toolName?: string } | undefined {
  const enabled = listMcpServers().filter((s) => s.enabled)
  for (const cfg of enabled) {
    const hit = pickSearchTool(cfg.lastStatus?.tools ?? [])
    if (hit) return { cfg, toolName: hit }
  }
  return enabled.filter((cfg) => SEARCH_NAME.test(cfg.name)).map((cfg) => ({ cfg }))[0]
}

/** 프롬프트가 web_search를 언급해도 되는지 — 없는 도구 이름을 알려 주면 모델이 그것을 부르려 든다 */
export function hasSearchServer(): boolean {
  return findSearchServer() !== undefined
}

/** 검색 MCP 서버가 등록돼 있으면 web_search 도구 하나를 돌려준다 (없으면 빈 도구셋) */
export async function searchTools(ctx: TurnContext): Promise<ToolSet> {
  const target = findSearchServer()
  if (!target) return {}
  const { cfg } = target

  const failedAt = cfg.lastStatus?.ok === false ? Date.parse(cfg.lastStatus.at) : NaN
  if (!Number.isNaN(failedAt) && Date.now() - failedAt < RETRY_AFTER_MS) return {}

  let toolName: string | undefined
  let underlying: { execute?: (input: unknown, options: unknown) => Promise<unknown> }
  try {
    const conn = await connectMcp(cfg)
    const names = Object.keys(conn.tools)
    toolName = target.toolName && names.includes(target.toolName) ? target.toolName : pickSearchTool(names)
    if (!toolName) return {}
    underlying = conn.tools[toolName] as typeof underlying
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    setMcpLastStatus(cfg.id, { ok: false, error, at: new Date().toISOString() })
    return {}
  }

  const called = toolName
  return {
    web_search: tool({
      description:
        `웹을 검색해 지금의 정보를 찾는다 (검색 MCP 서버: ${cfg.name}). ` +
        '학습 시점 이후에 달라졌을 수 있는 것(최신 버전·릴리스, 가격, 최근 사건, 문서 위치)은 ' +
        '기억으로 답하지 말고 이 도구로 확인한 뒤 답하라. 결과의 URL은 답변에 출처로 밝혀라.',
      inputSchema: z.object({
        query: z
          .string()
          .describe('검색어. 키워드를 나열하기보다 찾으려는 문서를 한 문장으로 묘사하는 편이 잘 걸린다'),
        purpose: PURPOSE_FIELD
      }),
      execute: async ({ query, purpose }, options) => {
        const summary = `웹 검색: ${query}`
        const gate = await checkPermission(ctx.win, {
          sessionId: ctx.sessionId,
          toolName: 'mcp',
          risk: 'execute',
          summary,
          // 권한 규칙은 MCP 도구와 같은 체계를 쓴다 — "서버이름:*"을 허용하면 검색도 함께 허용된다
          target: `${cfg.name}:${called}`,
          suggestedPattern: `${cfg.name}:*`,
          inputJson: JSON.stringify({ query }, null, 2),
          purpose: purpose?.trim() || undefined,
          unattended: ctx.unattended
        })
        if (!gate.allowed) {
          ctx.failures.push({ kind: 'approval-denied', detail: `${summary} — ${gate.reason}` })
          return { denied: true, reason: gate.reason }
        }
        try {
          const raw = await underlying.execute?.({ query }, options)
          // 검색 결과는 본문까지 실려 오는 경우가 많다. 창을 넘기면 문서로 빼내고 손잡이만 남긴다.
          return capToolResult(raw, ctx, summary)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          ctx.failures.push({ kind: 'tool-error', detail: `${summary} — ${msg}` })
          return { error: msg }
        }
      }
    })
  }
}
