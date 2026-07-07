import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { askPeer, delegateToPeer, peerSummaries } from './manager'

/** 메인(대화) 에이전트가 다른 에이전트를 호출하는 도구 */
export function peerTools(): ToolSet {
  return {
    list_peers: tool({
      description:
        '연결된 다른 사용자의 에이전트 목록과 각자의 전문 분야·스킬을 반환한다. ' +
        '요청이 내 전문 밖일 때 적합한 피어를 찾기 위해 사용하라.',
      inputSchema: z.object({}),
      execute: async () => peerSummaries()
    }),
    ask_peer: tool({
      description:
        '다른 에이전트에게 질문하고 답변을 받는다. 그 에이전트의 전문 지식이 필요할 때 사용하라. ' +
        '위임 전 어느 에이전트에게 무엇을 물을지 사용자에게 먼저 알려라.',
      inputSchema: z.object({
        peerId: z.string(),
        question: z.string().describe('상대 에이전트에게 보낼 자기완결적 질문')
      }),
      execute: async ({ peerId, question }) => {
        const res = await askPeer(peerId, question)
        return res.ok ? { answer: res.text } : { error: res.error }
      }
    }),
    delegate_to_peer: tool({
      description:
        '다른 에이전트에게 작업을 위임한다. 상대의 전문 작업이 필요하고 단순 질의로 부족할 때 사용하라. ' +
        '상대 사용자의 승인이 필요할 수 있다.',
      inputSchema: z.object({
        peerId: z.string(),
        title: z.string().describe('작업 제목 한 줄'),
        instruction: z.string().describe('상대 에이전트가 단독 수행할 자기완결적 지시')
      }),
      execute: async ({ peerId, title, instruction }) => {
        const res = await delegateToPeer(peerId, title, instruction)
        return res.ok ? { accepted: res.text, remoteTaskId: res.remoteTaskId } : { error: res.error }
      }
    })
  }
}

/** 피어 카드 요약을 시스템 프롬프트에 주입할 텍스트로 (없으면 빈 문자열) */
export function buildPeerContext(): string {
  const peers = peerSummaries()
  if (peers.length === 0) return ''
  const lines = peers.map(
    (p) => `- peerId=${p.id} "${p.name}" — ${p.specialty} (스킬: ${p.skills.join(', ') || '없음'})`
  )
  return (
    '## 연결된 다른 에이전트 (피어)\n' +
    lines.join('\n') +
    '\n요청이 내 전문 밖이고 적합한 피어가 있으면 ask_peer(질의) 또는 delegate_to_peer(작업 위임)를 사용하라. ' +
    '호출 전 어느 에이전트에게 무엇을 보낼지 사용자에게 알려라.'
  )
}
