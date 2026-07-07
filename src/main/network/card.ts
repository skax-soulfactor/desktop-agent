import { generateText } from 'ai'
import { z } from 'zod'
import type { AgentCard } from '@shared/types'
import { getModelFor } from '../llm/providers'
import { listMemories } from '../memory/store'
import { getMyCard, saveMyCard, getNetworkConfig } from './store'

/** '공유 제외' 태그가 붙은 기억은 카드 생성 입력에서 제외 */
export const NO_SHARE_TAG = '공유제외'

const cardShape = z.object({
  specialtySummary: z.string(),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string())
    })
  )
})

const PROMPT = `너는 에이전트의 전문 분야를 정의하는 도우미다. 아래 지식베이스 인덱스와 최근 작업 주제를 보고,
이 에이전트가 다른 에이전트에게 공개할 "에이전트 카드"의 전문 분야와 스킬을 도출하라.

규칙:
- specialtySummary: 이 에이전트의 전문 분야를 한 문장으로 (예: "Java 레거시 현대화와 TypeScript 데스크톱 앱 개발 전문").
- skills: 3~7개. 각 스킬은 다른 에이전트가 "이 에이전트에게 무엇을 물어보면 되는지" 판단할 수 있게 구체적으로.
  id는 영문 kebab-case, name/description은 한국어, tags는 검색용 키워드.
- 개인정보·자격증명·회사 내부 경로는 절대 포함하지 마라. 능력(무엇을 잘하는지)만 기술하라.
- 지식이 빈약하면 있는 만큼만, 일반적인 범용 조수로 기술하라.

출력은 아래 JSON만. 다른 텍스트·코드펜스 금지:
{"specialtySummary":"...","skills":[{"id":"...","name":"...","description":"...","tags":["..."]}]}`

function parseCard(raw: string): z.infer<typeof cardShape> {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('카드 JSON 파싱 실패')
  return cardShape.parse(JSON.parse(text.slice(start, end + 1)))
}

/** 지식베이스로부터 카드를 자동 생성/갱신. 사용자가 편집한 필드는 보존한다. */
export async function regenerateCard(): Promise<AgentCard> {
  const cfg = getNetworkConfig()
  const existing = getMyCard()
  const shareable = listMemories().filter((m) => !m.tags.includes(NO_SHARE_TAG))
  const index = shareable.map((m) => `- [${m.type}] ${m.title} (${m.tags.join(', ')})`).join('\n')

  const { text } = await generateText({
    model: getModelFor('light').model,
    system: PROMPT,
    prompt: `## 지식베이스 인덱스 (공유 가능 항목)\n${index || '(비어 있음)'}`
  })
  const parsed = parseCard(text)

  const edited = existing?.ext.userEditedFields ?? []
  const card: AgentCard = {
    protocolVersion: '0.3.0',
    name: edited.includes('name') && existing ? existing.name : `${defaultName()}의 에이전트`,
    description:
      edited.includes('description') && existing ? existing.description : parsed.specialtySummary,
    url: existing?.url ?? '',
    provider: existing?.provider,
    version: new Date().toISOString(),
    capabilities: { streaming: true },
    skills: edited.includes('skills') && existing ? existing.skills : parsed.skills,
    ext: {
      agentId: cfg.agentId,
      specialtySummary:
        edited.includes('specialtySummary') && existing
          ? existing.ext.specialtySummary
          : parsed.specialtySummary,
      acceptedTaskTypes: existing?.ext.acceptedTaskTypes ?? ['question', 'task'],
      cardGeneratedAt: new Date().toISOString(),
      userEditedFields: edited,
      autoUpdate: existing?.ext.autoUpdate ?? true
    }
  }
  saveMyCard(card)
  return card
}

function defaultName(): string {
  return process.env['USER'] || process.env['USERNAME'] || '사용자'
}

/** 카드가 없으면 최소 카드를 즉시 만든다 (LLM 없이) — 서버 기동/미리보기용 */
export function ensureCard(): AgentCard {
  const existing = getMyCard()
  if (existing) return existing
  const cfg = getNetworkConfig()
  const card: AgentCard = {
    protocolVersion: '0.3.0',
    name: `${defaultName()}의 에이전트`,
    description: '범용 데스크톱 협업 에이전트',
    url: '',
    version: new Date().toISOString(),
    capabilities: { streaming: true },
    skills: [],
    ext: {
      agentId: cfg.agentId,
      specialtySummary: '범용 협업 에이전트',
      acceptedTaskTypes: ['question', 'task'],
      cardGeneratedAt: new Date().toISOString(),
      userEditedFields: [],
      autoUpdate: true
    }
  }
  saveMyCard(card)
  return card
}

/** 현재 수신 주소를 카드 url에 반영 */
export function setCardUrl(url: string): void {
  const card = getMyCard()
  if (card && card.url !== url) {
    card.url = url
    saveMyCard(card)
  }
}
