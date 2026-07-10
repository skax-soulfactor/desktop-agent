import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { McpServerConfig } from '@shared/types'
import { listSecrets, hasSecret } from '../secrets/store'
import { requestSecretFromUser } from '../secrets/request'
import { listMcpServers, saveMcpServer } from '../mcp/store'
import { testMcpServer } from '../mcp/manager'
import { checkPermission } from '../permissions/gateway'

/**
 * 외부 서비스 연동을 에이전트가 스스로 진행할 수 있게 하는 도구 모음.
 * 메인(대화) 에이전트와 워커 양쪽에 노출된다.
 * - 시크릿: 값은 사용자 → 메인 프로세스로만 흐르고 LLM에는 저장 여부만 전달된다.
 * - MCP 서버 등록: 로컬 명령 실행이 수반될 수 있어 권한 게이트웨이 승인을 거친다.
 */
export function integrationTools(win: BrowserWindow, sessionId: string): ToolSet {
  return {
    list_secrets: tool({
      description:
        '저장된 연동 시크릿(API 토큰 등)의 이름 목록을 반환한다. 값은 조회할 수 없다. ' +
        'http_request 헤더나 MCP 서버 env/headers에 {{secret:이름}}으로 참조한다.',
      inputSchema: z.object({}),
      execute: async () => listSecrets()
    }),

    request_secret: tool({
      description:
        '사용자에게 시크릿(API 토큰, 키 등) 입력을 요청한다. 값은 너에게 노출되지 않고 OS 키체인에 암호화 저장되며, ' +
        '이후 {{secret:이름}} 플레이스홀더로 사용한다. 절대 채팅으로 토큰을 받지 말고 이 도구를 사용하라. ' +
        'purpose에는 왜 필요한지와 발급 방법(예: notion.so/my-integrations에서 발급)을 사용자에게 설명하라.',
      inputSchema: z.object({
        name: z
          .string()
          .regex(/^[\w.-]+$/, '영문·숫자·밑줄·점·하이픈만 사용')
          .describe('저장할 시크릿 이름 (예: notion)'),
        purpose: z.string().describe('용도와 발급 방법 설명 (사용자에게 표시됨)')
      }),
      execute: async ({ name, purpose }) => {
        if (hasSecret(name)) {
          return { alreadyExists: true, name, note: '이미 저장된 시크릿입니다. 그대로 사용하세요.' }
        }
        const outcome = await requestSecretFromUser(win, name, purpose)
        if (outcome === 'saved') return { saved: true, name, placeholder: `{{secret:${name}}}` }
        if (outcome === 'timeout') return { error: '사용자가 시간 내에 입력하지 않았습니다.' }
        return { denied: true, reason: '사용자가 시크릿 입력을 거부했습니다.' }
      }
    }),

    list_mcp_servers: tool({
      description:
        '등록된 MCP 서버 목록과 마지막 연결 상태(사용 가능한 도구 이름 포함)를 반환한다. ' +
        '활성화된 서버의 도구는 위임된 워커가 mcp_서버이름_도구이름 형태로 사용할 수 있다.',
      inputSchema: z.object({}),
      execute: async () =>
        listMcpServers().map((s) => ({
          id: s.id,
          name: s.name,
          transport: s.transport,
          enabled: s.enabled,
          lastStatus: s.lastStatus
        }))
    }),

    add_mcp_server: tool({
      description:
        'MCP 서버를 등록하고 연결을 테스트한다. 성공 시 사용 가능한 도구 목록을 반환한다. ' +
        'stdio는 로컬 명령 실행(예: command=npx, args=["-y","@notionhq/notion-mcp-server"]), ' +
        'http는 원격 서버 URL. env/headers 값에는 {{secret:이름}} 플레이스홀더를 사용하라. ' +
        '필요한 시크릿은 등록 전에 request_secret으로 확보하라.',
      inputSchema: z.object({
        name: z.string().describe('서버 이름 (예: notion). 도구 이름 접두어로 쓰인다'),
        transport: z.enum(['stdio', 'http']),
        command: z.string().optional().describe('stdio: 실행 명령'),
        args: z.array(z.string()).optional().describe('stdio: 명령 인자'),
        env: z.record(z.string()).optional().describe('stdio: 환경 변수 ({{secret:이름}} 가능)'),
        url: z.string().optional().describe('http: 서버 URL'),
        headers: z.record(z.string()).optional().describe('http: 요청 헤더 ({{secret:이름}} 가능)')
      }),
      execute: async (input) => {
        // MCP 서버 연결은 로컬 명령 실행·외부 접속을 수반하므로 승인 필수
        const summary =
          input.transport === 'stdio'
            ? `MCP 서버 등록: ${input.name} (${input.command ?? ''} ${(input.args ?? []).join(' ')})`
            : `MCP 서버 등록: ${input.name} (${input.url ?? ''})`
        const gate = await checkPermission(win, {
          sessionId,
          toolName: 'add_mcp_server',
          risk: 'execute',
          summary,
          target: input.name,
          suggestedPattern: input.name,
          inputJson: JSON.stringify(input, null, 2)
        })
        if (!gate.allowed) return { denied: true, reason: gate.reason }

        const existing = listMcpServers().find((s) => s.name === input.name)
        const config: McpServerConfig = {
          id: existing?.id ?? crypto.randomUUID(),
          name: input.name,
          transport: input.transport,
          command: input.command,
          args: input.args,
          env: input.env,
          url: input.url,
          headers: input.headers,
          enabled: true,
          createdAt: existing?.createdAt ?? new Date().toISOString()
        }
        saveMcpServer(config)
        const test = await testMcpServer(config.id)
        return test.ok
          ? { registered: config.name, tools: test.tools }
          : { registered: config.name, connectError: test.error }
      }
    })
  }
}
