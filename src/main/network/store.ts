import { randomBytes } from 'crypto'
import type { AgentCard, NetworkConfig, Peer, InboundRecord } from '@shared/types'
import { readJson, writeJson, appendLine, readLines } from '../storage/jsonStore'

// ── 네트워크 설정 ──────────────────────────────────────────────

export function getNetworkConfig(): NetworkConfig {
  const cfg = readJson<NetworkConfig | null>('network.json', null)
  if (cfg) return cfg
  const fresh: NetworkConfig = {
    agentId: crypto.randomUUID(),
    listenEnabled: false,
    listenPort: 7810
  }
  writeJson('network.json', fresh)
  return fresh
}

export function saveNetworkConfig(patch: Partial<NetworkConfig>): NetworkConfig {
  const next = { ...getNetworkConfig(), ...patch }
  writeJson('network.json', next)
  return next
}

// ── 내 에이전트 카드 ──────────────────────────────────────────

export function getMyCard(): AgentCard | null {
  return readJson<AgentCard | null>('agent-card.json', null)
}

export function saveMyCard(card: AgentCard): void {
  writeJson('agent-card.json', card)
}

// ── 피어 목록 ────────────────────────────────────────────────

export function listPeers(): Peer[] {
  return readJson<Peer[]>('peers.json', [])
}

export function getPeer(id: string): Peer | undefined {
  return listPeers().find((p) => p.id === id)
}

export function upsertPeer(peer: Peer): void {
  const all = listPeers()
  const idx = all.findIndex((p) => p.id === peer.id)
  if (idx >= 0) all[idx] = peer
  else all.push(peer)
  writeJson('peers.json', all)
}

export function updatePeer(id: string, patch: Partial<Peer>): Peer | null {
  const all = listPeers()
  const idx = all.findIndex((p) => p.id === id)
  if (idx < 0) return null
  all[idx] = { ...all[idx], ...patch }
  writeJson('peers.json', all)
  return all[idx]
}

export function deletePeer(id: string): void {
  writeJson(
    'peers.json',
    listPeers().filter((p) => p.id !== id)
  )
  const tokens = loadTokens()
  delete tokens[id]
  saveTokens(tokens)
}

/** 사용량 상한 — 날짜가 바뀌면 카운터 리셋 후 1 증가. 상한 초과면 false */
export function tryConsumeUsage(id: string): boolean {
  const peer = getPeer(id)
  if (!peer) return false
  const today = new Date().toISOString().slice(0, 10)
  const used = peer.usageDate === today ? peer.usedToday : 0
  if (used >= peer.policy.dailyLimit) return false
  updatePeer(id, { usageDate: today, usedToday: used + 1 })
  return true
}

// ── 페어링 토큰 (카드·주소와 분리 저장) ───────────────────────

interface TokenPair {
  /** 내가 상대에게 발급한 토큰 — 상대가 나를 호출할 때 제시 */
  myToken: string
  /** 상대가 나에게 발급한 토큰 — 내가 상대를 호출할 때 제시 */
  theirToken: string
}

type TokenFile = Record<string, TokenPair>

function loadTokens(): TokenFile {
  return readJson<TokenFile>('peer-tokens.json', {})
}

function saveTokens(t: TokenFile): void {
  writeJson('peer-tokens.json', t)
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export function setPeerTokens(peerId: string, tokens: TokenPair): void {
  const all = loadTokens()
  all[peerId] = tokens
  saveTokens(all)
}

export function getPeerTokens(peerId: string): TokenPair | undefined {
  return loadTokens()[peerId]
}

/** 수신 요청의 Bearer 토큰(=내가 그 피어에게 발급한 myToken)으로 피어를 찾는다 */
export function findPeerByMyToken(token: string): Peer | undefined {
  const tokens = loadTokens()
  for (const [peerId, pair] of Object.entries(tokens)) {
    if (pair.myToken === token) return getPeer(peerId)
  }
  return undefined
}

// ── 수신 요청 로그 ────────────────────────────────────────────

export function logInbound(rec: InboundRecord): void {
  appendLine('inbound.jsonl', JSON.stringify(rec))
}

export function listInbound(lastN = 100): InboundRecord[] {
  return readLines('inbound.jsonl', lastN)
    .map((l) => {
      try {
        return JSON.parse(l) as InboundRecord
      } catch {
        return null
      }
    })
    .filter((r): r is InboundRecord => r !== null)
    .reverse()
}
