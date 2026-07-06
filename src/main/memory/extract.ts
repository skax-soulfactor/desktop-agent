import { generateText } from 'ai'
import { z } from 'zod'
import type { MemoryOpSummary } from '@shared/types'
import { getActiveModel } from '../llm/providers'
import { createMemory, listMemories, updateMemory } from './store'

const opsSchema = z.object({
  ops: z.array(
    z.object({
      op: z.enum(['create', 'update', 'archive']),
      id: z.string().optional().describe('update/archive 시 대상 기억 id'),
      type: z.enum(['user', 'requirement', 'lesson', 'reference']).optional(),
      title: z.string().optional().describe('한 줄 요약'),
      content: z.string().optional().describe('본문 마크다운'),
      tags: z.array(z.string()).optional()
    })
  )
})

/** 이번 턴에서 수집된 실패 신호 (교훈 후보) */
export interface FailureSignal {
  kind: 'tool-error' | 'approval-denied' | 'user-correction'
  detail: string
}

const EXTRACT_PROMPT = `너는 데스크톱 에이전트의 기억 관리자다. 방금 끝난 대화 턴을 검토해 장기 기억으로 남길 것을 결정하라.

기억 타입:
- user: 사용자의 역할, 전문성, 선호 (예: "TypeScript 선호", "설명은 한국어로")
- requirement: 진행 중인 작업, 목표, 제약, 결정 사항
- lesson: 에이전트의 실수와 재발 방지 규칙. 본문은 반드시 "**상황:** ... **실수:** ... **원인:** ... **재발 방지:** ..." 형식
- reference: 외부 자원 포인터 (URL, 문서 위치)

규칙:
- 같은 주제의 기존 기억이 있으면 create 대신 update로 갱신하라. 중복 생성 금지.
- 사용자 발언이 기존 기억과 모순되면 기존 기억을 update하라.
- 일회성 내용, 이번 대화에만 유효한 내용은 저장하지 마라.
- 비밀번호, API 키, 토큰 등 민감 정보는 절대 저장하지 마라.
- 실패 신호(도구 오류, 승인 거부, 사용자 정정)가 있으면 lesson 생성을 우선 검토하라.
- 저장할 것이 없으면 ops를 빈 배열로 반환하라.
- 모든 기억은 한국어로 작성하라.

출력 형식: 아래 JSON만 출력하라. 설명, 인사, 마크다운 코드 펜스 등 다른 텍스트를 붙이지 마라.
{"ops":[{"op":"create","type":"user|requirement|lesson|reference","title":"한 줄 요약","content":"본문","tags":["태그"]}]}
update/archive 시에는 {"op":"update","id":"대상 기억 id",...} 형태로 id를 포함하라.`

/** 모델이 코드 펜스나 사족을 붙여도 JSON 본문만 골라 파싱한다 (구조화 출력 미지원 모델 호환) */
function parseOps(raw: string): z.infer<typeof opsSchema> {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`JSON 없음: ${raw.slice(0, 120)}`)
  const parsed: unknown = JSON.parse(text.slice(start, end + 1))
  const result = opsSchema.safeParse(parsed)
  if (!result.success) throw new Error(`형식 불일치: ${result.error.message.slice(0, 200)}`)
  return result.data
}

export async function extractMemories(
  sessionId: string,
  turnTranscript: string,
  failures: FailureSignal[]
): Promise<MemoryOpSummary[]> {
  const { model } = getActiveModel()
  const existing = listMemories()
    .map((m) => `- id=${m.id} [${m.type}] ${m.title}`)
    .join('\n')

  const failureText =
    failures.length > 0
      ? `\n\n## 이번 턴의 실패 신호 (교훈 후보)\n${failures.map((f) => `- (${f.kind}) ${f.detail}`).join('\n')}`
      : ''

  // generateObject(구조화 출력)는 일부 모델이 미지원이라, 어떤 챗 모델에서도 동작하는
  // generateText + 관대한 JSON 파싱을 사용한다
  const { text } = await generateText({
    model,
    system: EXTRACT_PROMPT,
    prompt: `## 기존 기억 목록\n${existing || '(없음)'}\n\n## 이번 턴 대화\n${turnTranscript.slice(-8000)}${failureText}`
  })
  const object = parseOps(text)

  const applied: MemoryOpSummary[] = []
  for (const op of object.ops) {
    if (op.op === 'create' && op.type && op.title && op.content) {
      createMemory({
        type: op.type,
        title: op.title,
        content: op.content,
        tags: op.tags ?? [],
        sourceSessionId: sessionId
      })
      applied.push({ op: 'create', type: op.type, title: op.title })
    } else if (op.op === 'update' && op.id) {
      const updated = updateMemory(op.id, {
        ...(op.type ? { type: op.type } : {}),
        ...(op.title ? { title: op.title } : {}),
        ...(op.content ? { content: op.content } : {}),
        ...(op.tags ? { tags: op.tags } : {})
      })
      if (updated) applied.push({ op: 'update', type: updated.type, title: updated.title })
    } else if (op.op === 'archive' && op.id) {
      const archived = updateMemory(op.id, { status: 'archived' })
      if (archived) applied.push({ op: 'archive', type: archived.type, title: archived.title })
    }
  }
  return applied
}
