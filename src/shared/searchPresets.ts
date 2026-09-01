import type { McpTransportKind } from './types'

/**
 * 검색 MCP 서버 프리셋.
 *
 * 값(패키지 이름, 환경 변수 이름, 원격 URL)은 지어내면 안 되는 것들이라 2026-09-01에 각
 * 제공자의 문서·레지스트리에서 확인했다. 에이전트의 프롬프트와 설정 화면이 같은 값을 쓰도록
 * 여기 한 곳에 둔다 — 두 곳에 따로 적으면 한쪽만 낡는다.
 */
export interface SearchMcpPreset {
  key: string
  /** MCP 서버 이름 — 도구 이름 접두어로 쓰인다 */
  name: string
  label: string
  transport: McpTransportKind
  url?: string
  command?: string
  args?: string[]
  /** 필요한 API 키를 담을 시크릿 이름 (없으면 키 없이 동작) */
  secret?: string
  /** stdio: 키를 넘길 환경 변수 이름 */
  envKey?: string
  /** 키 발급처·요금 등 사용자가 알아야 할 한 줄 */
  note: string
  homepage: string
}

export const SEARCH_MCP_PRESETS: SearchMcpPreset[] = [
  {
    key: 'duckduckgo',
    name: 'duckduckgo',
    label: 'DuckDuckGo (키 없이 무제한)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'duckduckgo-websearch'],
    note:
      'API 키도 카드도 필요 없다. 검색 문법(site:, filetype:, "정확한 구절")을 그대로 쓸 수 있고 페이지 본문을 읽는 도구도 함께 붙는다. 다만 검색 결과 페이지를 파싱하는 방식이라 DuckDuckGo가 차단하거나 화면을 바꾸면 조용히 실패할 수 있다 — 그때는 테스트 버튼으로 확인하라.',
    homepage: 'https://github.com/HeiSir2014/duckduckgo-mcp-server'
  },
  {
    key: 'exa',
    name: 'exa',
    label: 'Exa (키 없이 시작)',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    note: 'API 키 없이 바로 연결된다. 무료는 IP당 하루 7건이고, 키가 있으면 URL 뒤에 ?exaApiKey=키를 붙인다.',
    homepage: 'https://docs.exa.ai/reference/exa-mcp'
  },
  {
    key: 'tavily',
    name: 'tavily',
    label: 'Tavily (API 키 필요)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    secret: 'tavily',
    envKey: 'TAVILY_API_KEY',
    note: 'tavily.com에서 키를 발급받아 시크릿으로 저장한다. 검색 외에 본문 추출·크롤 도구도 함께 붙는다.',
    homepage: 'https://docs.tavily.com/documentation/mcp'
  },
  {
    key: 'brave',
    name: 'brave',
    label: 'Brave Search (API 키 필요)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    secret: 'brave',
    envKey: 'BRAVE_API_KEY',
    note: '웹·뉴스·이미지·지역 검색을 함께 제공한다. 2026-02에 무료 등급이 폐지되어 카드 등록이 필요하다(월 $5 크레딧 제공, 이후 1,000건당 $5).',
    homepage: 'https://github.com/brave/brave-search-mcp-server'
  }
]

/** 시스템 프롬프트에 넣을 등록 안내 (등록된 검색 서버가 없을 때만 쓴다) */
export function searchPresetHint(): string {
  const line = (p: SearchMcpPreset): string =>
    p.transport === 'http'
      ? `name="${p.name}", transport="http", url="${p.url}"`
      : `name="${p.name}", transport="stdio", command="${p.command}", args=${JSON.stringify(p.args)}` +
        (p.envKey && p.secret ? `, env={"${p.envKey}":"{{secret:${p.secret}}}"}` : '')

  const free = SEARCH_MCP_PRESETS.filter((p) => !p.secret)
  const paid = SEARCH_MCP_PRESETS.filter((p) => p.secret)
  return (
    `키 없이 바로 되는 것: ${free.map(line).join(' / ')}. ` +
    `키가 있으면: ${paid.map(line).join(' / ')} — 키는 request_secret으로 먼저 받아라.`
  )
}
