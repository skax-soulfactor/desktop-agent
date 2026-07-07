import type { AgentCard } from '@shared/types'
import type {
  A2ARequest,
  A2AResponse,
  A2AStreamEvent,
  AgentTransport,
  InboundHandlers,
  PairRequestBody,
  PairResponseBody
} from './protocol'

/**
 * v2 중계서버 전송 (스텁).
 * 실제 중계서버(WebSocket 라우팅·카드 디렉토리·NAT 통과·오프라인 큐)는 별도 프로젝트다.
 * 이 클래스는 AgentTransport 계약이 relay 방식에도 그대로 적용됨을 보이는 확장 지점이며,
 * relayUrl이 설정되면 여기에 WebSocket 클라이언트 로직을 채운다.
 * 상위 로직(페어링·라우팅·워커)은 이 파일만 교체하면 되고 변경되지 않는다.
 */
export class RelayTransport implements AgentTransport {
  constructor(private readonly relayUrl: string) {}

  private notReady(): never {
    throw new Error('중계서버(RelayTransport)는 아직 구현되지 않았습니다. 직접 연결(IP:Port)을 사용하세요.')
  }

  publicAddress(): string | null {
    return null
  }
  async fetchCard(_address: string): Promise<AgentCard> {
    return this.notReady()
  }
  async pair(_address: string, _body: PairRequestBody): Promise<PairResponseBody> {
    return this.notReady()
  }
  async send(
    _address: string,
    _token: string,
    _req: A2ARequest,
    _onEvent?: (e: A2AStreamEvent) => void
  ): Promise<A2AResponse> {
    return this.notReady()
  }
  async listen(_handlers: InboundHandlers): Promise<void> {
    return this.notReady()
  }
  async stop(): Promise<void> {
    // no-op
  }
}
