import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'http'
import { networkInterfaces } from 'os'
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

const MAX_BODY = 5 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > MAX_BODY) reject(new Error('요청 본문이 너무 큽니다.'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function firstLanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

/** http://host:port 또는 host:port를 정규화 (경로 없이 origin만) */
function normalizeAddress(address: string): string {
  let a = address.trim()
  if (!/^https?:\/\//.test(a)) a = `http://${a}`
  const u = new URL(a)
  return `${u.protocol}//${u.host}`
}

async function postJson(origin: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const u = new URL(origin + path)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        timeout: 30_000
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {})
          } catch {
            reject(new Error(`잘못된 응답 (HTTP ${res.statusCode})`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('연결 시간 초과')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export class DirectHttpTransport implements AgentTransport {
  private server: Server | null = null
  private port = 0

  constructor(private readonly listenPort: number) {}

  publicAddress(): string | null {
    return this.server ? `http://${firstLanIPv4()}:${this.port}` : null
  }

  async fetchCard(address: string): Promise<AgentCard> {
    const origin = normalizeAddress(address)
    const u = new URL(origin + '/.well-known/agent-card.json')
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 15_000 },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as AgentCard)
            } catch {
              reject(new Error('에이전트 카드를 읽지 못했습니다. 주소를 확인하세요.'))
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('연결 시간 초과')))
      req.on('error', () => reject(new Error('연결 실패. IP·Port와 상대 앱의 수신 상태를 확인하세요.')))
      req.end()
    })
  }

  async pair(address: string, body: PairRequestBody): Promise<PairResponseBody> {
    return (await postJson(normalizeAddress(address), '/pair', body)) as PairResponseBody
  }

  async send(
    address: string,
    token: string,
    req: A2ARequest,
    onEvent?: (e: A2AStreamEvent) => void
  ): Promise<A2AResponse> {
    // v1은 비스트리밍 요청/응답. 스트리밍 이벤트는 최종 결과를 done으로 전달만.
    const res = (await postJson(normalizeAddress(address), '/a2a', req, token)) as A2AResponse
    if (onEvent) onEvent(res.ok ? { type: 'done', text: res.text ?? '' } : { type: 'error', error: res.error ?? '오류' })
    return res
  }

  async listen(handlers: InboundHandlers): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => {
      void this.route(req, res, handlers)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.listenPort, () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : this.listenPort
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    handlers: InboundHandlers
  ): Promise<void> {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        return send(200, handlers.getCard())
      }
      if (req.method === 'POST' && req.url === '/pair') {
        const body = JSON.parse(await readBody(req)) as PairRequestBody
        const remote = req.socket.remoteAddress ?? 'unknown'
        return send(200, await handlers.onPair(body, remote))
      }
      if (req.method === 'POST' && req.url === '/a2a') {
        const auth = req.headers['authorization'] ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const peerId = handlers.authenticate(token)
        if (!peerId) return send(401, { ok: false, error: '인증 실패 (페어링되지 않은 요청)' })
        const body = JSON.parse(await readBody(req)) as A2ARequest
        const result = await handlers.onRequest(peerId, body, () => {})
        return send(200, result)
      }
      send(404, { error: 'not found' })
    } catch (e) {
      send(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
