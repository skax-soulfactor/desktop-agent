import { z } from 'zod'
import type { MemoryOpSummary } from '@shared/types'
import { completeText } from '../llm/complete'
import { estimateTokens, fitToTokens } from '../llm/profile'
import { resolveModelFor } from '../llm/providers'
import { createMemory, listMemories, updateMemory } from './store'
import { recordUsage } from '../usage/store'

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
- lesson: 에이전트의 실수와 재발 방지 규칙. 본문은 반드시 아래 네 항목을 각각 빈 줄(\\n\\n)로 구분해 작성하라.
  "**상황:** ...\\n\\n**실수:** ...\\n\\n**원인:** ...\\n\\n**재발 방지:** ..."
  한 줄로 이어 쓰지 마라. 사용자가 지식베이스 화면에서 항목별로 읽는다.
- reference: 외부 자원 포인터 (URL, 문서 위치)

규칙:
- 같은 주제의 기존 기억이 있으면 create 대신 update로 갱신하라. 중복 생성 금지.
- 사용자 발언이 기존 기억과 모순되면 기존 기억을 update하라.
- 일회성 내용, 이번 대화에만 유효한 내용은 저장하지 마라.
- 검증되지 않은 진단이나 해결책을 사실로 저장하지 마라. "A로 B를 해결했다"는 사용자가 해결을 확인해 준 경우에만 저장한다.
  아직 시도 중이거나 효과가 확인되지 않았으면 저장하지 마라. 틀린 기억은 이후 대화를 계속 오염시킨다.
- 이전에 저장한 내용이 이번 턴에서 틀린 것으로 드러나면 반드시 update로 정정하거나 archive하라.
- 비밀번호, API 키, 토큰 등 민감 정보는 절대 저장하지 마라.
- 실패 신호(도구 오류, 승인 거부, 사용자 정정)가 있으면 lesson 생성을 우선 검토하라.
- 저장할 것이 없으면 ops를 빈 배열로 반환하라.
- 모든 기억은 한국어로 작성하라.

출력 형식: 아래 JSON만 출력하라. 설명, 인사, 마크다운 코드 펜스 등 다른 텍스트를 붙이지 마라.
{"ops":[{"op":"create","type":"user|requirement|lesson|reference","title":"한 줄 요약","content":"본문","tags":["태그"]}]}
update/archive 시에는 {"op":"update","id":"대상 기억 id",...} 형태로 id를 포함하라.`

/**
 * 좁은 컨텍스트(로컬 모델)용 축약본. 전체 프롬프트는 2,500자가 넘어, 기존 기억 목록과
 * 턴 기록까지 더하면 Ollama 기본 창(4096토큰)을 넘겨 출력이 중간에 끊긴다.
 */
const COMPACT_EXTRACT_PROMPT = `너는 데스크톱 에이전트의 기억 관리자다. 방금 끝난 대화 턴에서 장기 기억으로 남길 것만 뽑아라.

타입: user(역할·전문성·선호) / requirement(진행 중 작업·목표·제약) / lesson(에이전트의 실수와 재발 방지) / reference(URL·문서 위치)

규칙:
- 같은 주제의 기존 기억이 있으면 create 대신 update(id 포함).
- 일회성 내용, 검증되지 않은 진단·해결책은 저장하지 마라.
- 비밀번호·API 키·토큰은 절대 저장하지 마라.
- 저장할 것이 없으면 ops를 빈 배열로 반환하라.
- 모든 기억은 한국어로 짧게 쓴다. lesson 본문은 "**상황:** ...\\n\\n**실수:** ...\\n\\n**원인:** ...\\n\\n**재발 방지:** ..." 형식.

아래 JSON만 출력하라. 설명·인사·코드 펜스 금지.
{"ops":[{"op":"create","type":"user","title":"한 줄 요약","content":"본문","tags":["태그"]}]}`

/** 모델이 코드 펜스나 사족을 붙여도 JSON 본문만 골라 파싱한다 (구조화 출력 미지원 모델 호환) */
function parseOps(raw: string): z.infer<typeof opsSchema> {
  // 로컬 사고형 모델(qwen3 계열 등)은 <think> 블록을 본문 앞에 붙인다.
  // 닫히지 않은 채 끊긴 경우도 있으므로 열림 태그 이후를 통째로 버린다.
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (/<think>/i.test(text)) text = text.replace(/<think>[\s\S]*$/i, '').trim()

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  let end = text.lastIndexOf('}')
  // 출력 상한에 걸려 끊긴 JSON — 마지막으로 온전한 op까지만 복구한다.
  // 실패로 버리면 이번 턴의 기억이 통째로 사라진다.
  if (start >= 0 && end <= start) {
    const lastOp = text.lastIndexOf('},')
    if (lastOp > start) {
      text = `${text.slice(0, lastOp + 1)}]}`
      end = text.length - 1
    }
  }
  if (start < 0 || end <= start) throw new Error(`JSON 없음: ${raw.slice(0, 120)}`)
  const parsed: unknown = JSON.parse(text.slice(start, end + 1))
  const result = opsSchema.safeParse(parsed)
  if (!result.success) throw new Error(`형식 불일치: ${result.error.message.slice(0, 200)}`)
  return result.data
}

/**
 * 이번 턴에 도구로 확인한 것이 하나도 없을 때 덧붙이는 규칙.
 *
 * 기존 규칙("검증되지 않은 진단이나 해결책을 저장하지 마라")은 진단·해결책만 겨눈다.
 * "IntelliJ 릴리스 주기는 6~8주" 같은 것은 진단이 아니라 세상 사실이라 그물에 걸리지 않고
 * 그대로 저장됐다(실제로는 연 3회다). 사실이 아니라 출처를 기준으로 자른다.
 */
const UNVERIFIED_RULE = `

## 이번 턴에는 도구로 확인한 것이 하나도 없다
- 그러므로 에이전트가 설명한 외부 사실은 저장하지 마라 — 제품의 버전·릴리스 주기·가격·정책,
  도구나 서비스의 동작 원리, 기술적 사실 관계는 확인 없이 지식이 되면 안 된다.
  에이전트가 확신에 차서 말했든, 출처를 적었든 마찬가지다. 이번 턴에 그 출처를 실제로 연 적이 없다.
- 사용자가 직접 말한 것만 저장하라: 선호, 사용하는 환경·도구, 요구사항, 결정, 앞으로의 계획.
  판단 기준은 "누가 말했는가"다. 사용자가 말한 것은 그 자체로 사실이고, 에이전트가 말한 것은 아직 주장이다.
- 저장할 것이 없으면 ops를 빈 배열로 반환하라. 그것이 이 턴의 정상적인 결과다.`

export async function extractMemories(
  sessionId: string,
  turnTranscript: string,
  failures: FailureSignal[],
  /** 이번 턴에 결과를 돌려준 도구가 하나라도 있었는가 */
  verified = false
): Promise<MemoryOpSummary[]> {
  // 배경 작업이므로 경량 등급 사용 (미배정 시 일반으로 폴백)
  const { model, config, profile } = await resolveModelFor('light')
  const base = profile.local ? COMPACT_EXTRACT_PROMPT : EXTRACT_PROMPT
  const system = verified ? base : base + UNVERIFIED_RULE

  const failureText =
    failures.length > 0
      ? `\n\n## 이번 턴의 실패 신호 (교훈 후보)\n${failures.map((f) => `- (${f.kind}) ${f.detail}`).join('\n')}`
      : ''

  // 남은 예산을 기존 기억 목록과 턴 기록이 나눠 쓴다. 넘기면 서버가 앞부분을 잘라내
  // 지시가 사라진 채 모델이 아무 텍스트나 뱉는다.
  const inputBudget =
    profile.promptBudget - estimateTokens(system) - estimateTokens(failureText) - 128
  const existing = fitToTokens(
    listMemories()
      .map((m) => `- id=${m.id} [${m.type}] ${m.title}`)
      .join('\n'),
    Math.max(0, Math.floor(inputBudget * 0.3))
  )
  const transcript = fitToTokens(
    turnTranscript,
    Math.max(256, Math.floor(inputBudget * 0.7)),
    false // 턴의 끝(가장 최근 발언)이 기억할 값이 크다
  )

  // generateObject(구조화 출력)는 일부 모델이 미지원이라, 어떤 챗 모델에서도 동작하는
  // 텍스트 생성 + 관대한 JSON 파싱을 사용한다
  const { text, usage } = await completeText({
    model,
    system,
    prompt: `## 기존 기억 목록\n${existing || '(없음)'}\n\n## 이번 턴 대화\n${transcript}${failureText}`,
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {})
  })
  recordUsage(
    { sessionId, kind: 'memory', provider: config.label, model: config.model, tier: 'light' },
    usage
  )
  const object = parseOps(text)

  const applied: MemoryOpSummary[] = []
  for (const op of object.ops) {
    if (op.op === 'create' && op.type && op.title && op.content) {
      // 프롬프트로 걸러지지 않고 넘어온 것도 있다 — 9B 추출기는 규칙을 늘 지키지는 않는다.
      // 지우지 않고 표시해 둔다. 회상에서 "확인 안 됨"으로 붙어 나가고 출처로는 쓰이지 못한다.
      const created = createMemory({
        type: op.type,
        title: op.title,
        content: op.content,
        tags: op.tags ?? [],
        sourceSessionId: sessionId,
        ...(verified ? {} : { unverified: true })
      })
      applied.push({ op: 'create', type: op.type, title: op.title, id: created.id })
    } else if (op.op === 'update' && op.id) {
      // 확인된 턴의 갱신은 표시를 걷어내고, 확인 없는 턴의 갱신은 표시를 남긴다.
      // 미확인 내용이 기존 기억에 덧씌워지면 그 기억도 더는 확인된 것이 아니다.
      const updated = updateMemory(op.id, {
        ...(op.type ? { type: op.type } : {}),
        ...(op.title ? { title: op.title } : {}),
        ...(op.content ? { content: op.content } : {}),
        ...(op.tags ? { tags: op.tags } : {}),
        ...(op.content ? { unverified: !verified } : {})
      })
      if (updated)
        applied.push({ op: 'update', type: updated.type, title: updated.title, id: updated.id })
    } else if (op.op === 'archive' && op.id) {
      const archived = updateMemory(op.id, { status: 'archived' })
      if (archived)
        applied.push({ op: 'archive', type: archived.type, title: archived.title, id: archived.id })
    }
  }
  return applied
}
