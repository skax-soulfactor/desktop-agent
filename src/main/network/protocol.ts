import type { AgentCard } from '@shared/types'

/** A2A 준용 요청/응답 (JSON-RPC 2.0 위에 실림) */
export interface A2ARequest {
  taskType: 'question' | 'task'
  title: string
  text: string
  /** 순환 호출 방지용 호출 체인 (agentId 목록) */
  callChain: string[]
}

export interface A2AResponse {
  ok: boolean
  /** question: 답변 텍스트, task: 수락 메시지 */
  text?: string
  /** task 위임 시 원격 작업 핸들 */
  remoteTaskId?: string
  error?: string
}

export type A2AStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string }

export interface PairRequestBody {
  requesterCard: AgentCard
  /** 요청자가 응답자에게 부여하는 토큰(응답자가 요청자를 호출할 때 사용) */
  requesterIssuedToken: string
}

export interface PairResponseBody {
  accepted: boolean
  responderCard?: AgentCard
  /** 응답자가 요청자에게 부여하는 토큰 */
  responderIssuedToken?: string
  reason?: string
}

/** 수신 핸들러 — 서버 구현이 호출한다 */
export interface InboundHandlers {
  /** GET /.well-known/agent-card.json */
  getCard(): AgentCard
  /** POST /pair — 반환값이 응답 바디. 사용자 승인을 내부에서 대기 */
  onPair(body: PairRequestBody, remoteAddress: string): Promise<PairResponseBody>
  /** POST /a2a message — 토큰은 서버가 검증해 peerId를 넘긴다 */
  onRequest(
    peerId: string,
    req: A2ARequest,
    onEvent: (e: A2AStreamEvent) => void
  ): Promise<A2AResponse>
  /** Bearer 토큰 → peerId. 유효하지 않으면 null */
  authenticate(token: string): string | null
}

/**
 * 전송 추상화. DirectHttpTransport(v1, http://ip:port)와
 * RelayTransport(v2, relay://host/agentId)가 이 인터페이스를 구현한다.
 * 상위 로직(페어링·라우팅·워커)은 전송 방식과 무관하다.
 */
export interface AgentTransport {
  /** 인증 없이 카드만 미리 읽는다 (페어링 전) */
  fetchCard(address: string): Promise<AgentCard>
  /** 페어링 요청 전송 */
  pair(address: string, body: PairRequestBody): Promise<PairResponseBody>
  /** 요청 전송. onEvent가 있으면 스트리밍 */
  send(
    address: string,
    token: string,
    req: A2ARequest,
    onEvent?: (e: A2AStreamEvent) => void
  ): Promise<A2AResponse>
  /** 수신 서버 기동 */
  listen(handlers: InboundHandlers): Promise<void>
  stop(): Promise<void>
  /** 현재 바인딩된 공개 주소 (카드 url에 넣을 값). 미기동 시 null */
  publicAddress(): string | null
}
