import tls from 'node:tls'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

let dispatcher: Agent | undefined

function getDispatcher(): Agent {
  if (!dispatcher) {
    // Node 기본 CA(Mozilla) + OS 신뢰 저장소(Windows: 회사 SSL 검사 루트 CA 등)
    const ca = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')]
    dispatcher = new Agent({
      connect: { ca },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000
    })
  }
  return dispatcher
}

/**
 * 회사망 SSL 검사(프록시 MITM) 환경에서 global fetch는 SELF_SIGNED_CERT_IN_CHAIN으로
 * 실패할 수 있다. OS 신뢰 저장소 CA를 TLS 검증에 포함한 fetch를 LLM API 호출에 사용한다.
 */
export function enterpriseFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const options = { ...init, dispatcher: getDispatcher() } as UndiciRequestInit
  return undiciFetch(input as string, options) as Promise<Response>
}
