import { useEffect, useState } from 'react'
import type { AgentCard, InboundRecord, NetworkConfig, Peer, PeerRequestPolicy } from '@shared/types'

const POLICY_LABEL: Record<PeerRequestPolicy, string> = { auto: '자동 허용', ask: '승인 요청', deny: '차단' }

export default function NetworkView(): JSX.Element {
  const [config, setConfig] = useState<NetworkConfig | null>(null)
  const [card, setCard] = useState<AgentCard | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])
  const [inbound, setInbound] = useState<InboundRecord[]>([])
  const [address, setAddress] = useState('')
  const [preview, setPreview] = useState<AgentCard | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [editingCard, setEditingCard] = useState(false)
  const [draftDesc, setDraftDesc] = useState('')

  const refresh = async (): Promise<void> => {
    setConfig(await window.api.netConfig())
    setCard(await window.api.netGetCard())
    setPeers(await window.api.netListPeers())
    setInbound(await window.api.netListInbound())
  }

  useEffect(() => {
    void refresh()
    const off = window.api.onPeersChanged(() => void refresh())
    return off
  }, [])

  const toggleListen = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (on) await window.api.netStartListening()
      else await window.api.netStopListening()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const regenCard = async (): Promise<void> => {
    setBusy(true)
    setMsg('지식베이스를 분석해 카드를 생성 중...')
    try {
      setCard(await window.api.netRegenCard())
      setMsg('카드를 갱신했습니다.')
    } catch (e) {
      setMsg(`카드 생성 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const saveDesc = async (): Promise<void> => {
    if (!card) return
    const edited = Array.from(new Set([...card.ext.userEditedFields, 'description']))
    const next: AgentCard = { ...card, description: draftDesc, ext: { ...card.ext, userEditedFields: edited } }
    await window.api.netSaveCard(next)
    setCard(next)
    setEditingCard(false)
  }

  const doPreview = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    setPreview(null)
    try {
      setPreview(await window.api.netFetchCard(address))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doPair = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.api.netPair(address)
      if (res.ok) {
        setMsg(`"${res.peer?.name}" 연결됨.`)
        setPreview(null)
        setAddress('')
        await refresh()
      } else {
        setMsg(res.error ?? '페어링 실패')
      }
    } finally {
      setBusy(false)
    }
  }

  const setPolicy = async (peer: Peer, field: 'question' | 'task', value: PeerRequestPolicy): Promise<void> => {
    await window.api.netUpdatePeerPolicy(peer.id, { ...peer.policy, [field]: value })
    await refresh()
  }

  return (
    <div className="page">
      <h2>에이전트 네트워크</h2>

      <h3>내 에이전트 카드</h3>
      <div className="card">
        {!card && <div className="empty">카드가 없습니다. 생성하세요.</div>}
        {card && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{card.name}</strong>
              <div className="row">
                <button onClick={() => { setEditingCard(true); setDraftDesc(card.description) }}>설명 편집</button>
                <button onClick={() => void regenCard()} disabled={busy}>지금 갱신</button>
              </div>
            </div>
            {editingCard ? (
              <div className="row" style={{ marginTop: 8 }}>
                <input style={{ flex: 1 }} value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
                <button className="primary" onClick={() => void saveDesc()}>저장</button>
                <button onClick={() => setEditingCard(false)}>취소</button>
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)', marginTop: 6 }}>{card.description}</div>
            )}
            <div style={{ marginTop: 10 }}>
              {card.skills.map((s) => (
                <span key={s.id} className="tag" title={s.description}>{s.name}</span>
              ))}
              {card.skills.length === 0 && <span className="dim">스킬 없음 — "지금 갱신"으로 지식베이스에서 생성</span>}
            </div>
          </>
        )}
      </div>

      <h3>수신 서버</h3>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="dim">
            {config?.listenEnabled ? (
              <>수신 중 · 내 주소: <code>{card?.url || '(주소 확인 중)'}</code></>
            ) : (
              '수신 꺼짐 (발신 전용)'
            )}
            <div>포트: {config?.listenPort}</div>
          </div>
          <button
            className={config?.listenEnabled ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void toggleListen(!config?.listenEnabled)}
          >
            {config?.listenEnabled ? '수신 끄기' : '수신 켜기'}
          </button>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          다른 사용자가 이 주소(IP:Port)로 연결·질의합니다. 같은 네트워크(LAN/VPN)에서 동작합니다.
        </div>
      </div>

      <h3>피어 추가</h3>
      <div className="card">
        <div className="row">
          <input
            style={{ flex: 1 }}
            placeholder="상대 주소 (예: 192.168.0.20:7810)"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button onClick={() => void doPreview()} disabled={busy || !address}>카드 미리보기</button>
        </div>
        {preview && (
          <div className="card" style={{ marginTop: 10 }}>
            <strong>{preview.name}</strong>
            <div className="dim" style={{ marginTop: 4 }}>{preview.ext.specialtySummary}</div>
            <div style={{ marginTop: 8 }}>
              {preview.skills.map((s) => <span key={s.id} className="tag">{s.name}</span>)}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => void doPair()} disabled={busy}>페어링 요청</button>
            </div>
          </div>
        )}
        {msg && <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>{msg}</div>}
      </div>

      <h3>연결된 피어 ({peers.length})</h3>
      <div className="card">
        {peers.length === 0 && <div className="empty">연결된 에이전트가 없습니다.</div>}
        {peers.length > 0 && (
          <table>
            <thead>
              <tr><th>이름</th><th>전문 분야</th><th>질의</th><th>작업</th><th>상태</th><th></th></tr>
            </thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="dim">{p.card.ext.specialtySummary}</td>
                  <td>
                    <select value={p.policy.question} onChange={(e) => void setPolicy(p, 'question', e.target.value as PeerRequestPolicy)}>
                      {(['auto', 'ask', 'deny'] as PeerRequestPolicy[]).map((v) => <option key={v} value={v}>{POLICY_LABEL[v]}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={p.policy.task} onChange={(e) => void setPolicy(p, 'task', e.target.value as PeerRequestPolicy)}>
                      {(['auto', 'ask', 'deny'] as PeerRequestPolicy[]).map((v) => <option key={v} value={v}>{POLICY_LABEL[v]}</option>)}
                    </select>
                  </td>
                  <td className="dim">{p.status}</td>
                  <td><button className="danger" onClick={() => void window.api.netDeletePeer(p.id).then(refresh)}>해제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3>수신 요청 로그</h3>
      <div className="card">
        {inbound.length === 0 && <div className="empty">아직 수신 요청이 없습니다.</div>}
        {inbound.length > 0 && (
          <table>
            <thead><tr><th>시각</th><th>피어</th><th>유형</th><th>내용</th><th>결과</th></tr></thead>
            <tbody>
              {inbound.map((r) => (
                <tr key={r.id}>
                  <td className="dim">{new Date(r.at).toLocaleString()}</td>
                  <td>{r.peerName}</td>
                  <td className="dim">{r.taskType === 'question' ? '질의' : '작업'}</td>
                  <td className="dim">{r.summary}</td>
                  <td className="dim">{r.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
