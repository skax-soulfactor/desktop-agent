import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { TaskInfo } from '@shared/types'
import { completeText } from '../llm/complete'
import { estimateTokens, type ModelProfile } from '../llm/profile'
import { resolveModelFor } from '../llm/providers'
import { describeError } from '../llm/errors'
import { recordUsage } from '../usage/store'
import { resolveSkill } from '../skills/store'

/**
 * 모델 창보다 큰 첨부를 다루기 위한 문서 저장소와 분할 처리 파이프라인.
 *
 * 좁은 창(로컬 모델 4K~8K)에서 40KB짜리 문서를 번역해 달라는 요청은 한 번의 호출로는
 * 불가능하다. 잘라서 "앞부분만 했다"고 답하는 건 에이전트가 할 일을 사용자에게 넘기는 것이다.
 * 여기서는 문서를 창에 맞는 조각으로 나눠 차례로 처리하고 결과를 다시 합친다.
 */

export interface StoredDocument {
  id: string
  sessionId: string
  name: string
  text: string
  tokens: number
}

const documents = new Map<string, StoredDocument>()

export function registerDocument(sessionId: string, name: string, text: string): StoredDocument {
  const doc: StoredDocument = {
    id: crypto.randomUUID().slice(0, 8),
    sessionId,
    name,
    text,
    tokens: estimateTokens(text)
  }
  documents.set(doc.id, doc)
  return doc
}

export function getDocument(id: string): StoredDocument | undefined {
  return documents.get(id)
}

/**
 * 문단·제목 경계를 지키며 예산에 맞는 조각으로 나눈다.
 * 문장 중간에서 끊으면 조각마다 앞뒤가 잘린 문장이 생겨 번역·요약 품질이 눈에 띄게 나빠진다.
 */
export function splitIntoChunks(text: string, chunkTokens: number): string[] {
  const blocks = text.split(/\n(?=#{1,6} )|\n\n/)
  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim()) chunks.push(current)
    current = ''
  }

  for (const block of blocks) {
    if (estimateTokens(block) > chunkTokens) {
      // 한 문단이 통째로 예산을 넘으면 줄 단위로 쪼갠다
      flush()
      let line = ''
      for (const raw of block.split('\n')) {
        if (line && estimateTokens(line + raw) > chunkTokens) {
          chunks.push(line)
          line = ''
        }
        line += (line ? '\n' : '') + raw
      }
      if (line.trim()) chunks.push(line)
      continue
    }
    if (current && estimateTokens(current + '\n\n' + block) > chunkTokens) flush()
    current += (current ? '\n\n' : '') + block
  }
  flush()
  return chunks
}

/**
 * 조각 하나에 허용할 입력 토큰.
 *
 * 프롬프트 예산뿐 아니라 출력 상한도 함께 본다 — 번역·재작성은 결과가 입력만큼 길어지므로,
 * 입력을 출력 상한보다 크게 잡으면 조각마다 결과가 잘린다.
 */
function chunkBudget(profile: ModelProfile, overheadTokens: number): number {
  const byPrompt = profile.promptBudget - overheadTokens
  const byOutput = Math.floor((profile.maxOutputTokens ?? 4096) * 0.7)
  return Math.max(256, Math.min(byPrompt, byOutput))
}

const TRANSFORM_PROMPT = `너는 긴 문서를 조각으로 나눠 처리하는 처리기다. 아래 지시를 이번 조각에만 적용해 결과만 출력하라.

- 결과 외의 말을 붙이지 마라. 인사, 설명, "이 조각은", "계속됩니다" 같은 말 금지.
- 원문을 다시 인용하지 마라. 변환 결과만 낸다.
- 조각이 문장 중간에서 시작하거나 끝나도 그대로 처리하라. 조각 경계를 언급하지 마라.
- 제목(#)과 표 머리글도 본문과 똑같이 처리 대상이다. 빠뜨리지 마라.
- 코드 블록(\`\`\`) 안의 코드, 식별자, 파일 경로는 원문 그대로 두어라. 그 밖의 모든 문장은 처리하라.
- 줄바꿈·목록·표 같은 마크다운 서식은 입력과 같은 모양으로 낸다.`

const REDUCE_PROMPT = `너는 여러 조각을 각각 처리한 결과를 하나로 합치는 병합기다.

- 아래 부분 결과들을 원래 지시에 맞는 하나의 완결된 결과로 합쳐라.
- 중복을 제거하고 순서를 정리하되, 부분 결과에 없는 내용을 지어내지 마라.
- 결과만 출력하라. 병합 과정에 대한 설명을 붙이지 마라.`

export interface DocumentJobHooks {
  /** 진행 상황 표시 (예: "3/7 조각") */
  onProgress(done: number, total: number): void
  signal: AbortSignal
}

export interface DocumentJobResult {
  text: string
  chunks: number
  /** 재시도 후에도 원문 그대로였던 조각 수 — 결과가 부분적으로만 처리됐음을 알리는 데 쓴다 */
  unchanged: number
  inputTokens: number
  outputTokens: number
}

/** 코드 블록은 원문 유지가 정답이므로 변환 여부 판정에서 제외한다 */
function proseOnly(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 모델이 지시를 적용하지 않고 원문을 그대로 돌려줬는지 판단한다.
 *
 * 실측: 디렉토리 트리처럼 99%가 코드 블록인 조각은 원문 그대로가 정답이라 단순 비교로는
 * 오탐이 난다. 그래서 코드 블록 밖의 산문만 비교한다. 산문이 없는 조각은 실패가 아니다.
 * 지시를 시스템 프롬프트 앞에 두는 것으로 대부분 해결되지만, 남는 경우를 위한 안전망이다.
 */
export function looksUnchanged(source: string, output: string): boolean {
  if (!output.trim()) return true
  const a = proseOnly(source)
  const b = proseOnly(output)
  if (!a) return false // 코드뿐인 조각 — 바꿀 산문이 없다
  if (!b) return true
  if (a === b) return true

  // 앞부분이 길게 일치하면 복사본이다
  const n = Math.min(a.length, b.length)
  let same = 0
  while (same < n && a[same] === b[same]) same++
  if (same >= Math.min(200, n * 0.5)) return true

  // 출력 단어가 대부분 원문에 그대로 있으면 변환되지 않은 것이다. 순서를 바꾸거나
  // 일부를 줄여 놓아도 잡힌다 — 앞부분 비교만으로는 그런 경우를 놓친다.
  // 같은 언어로 요약하는 작업은 여기서 오탐이 날 수 있지만, 오탐의 대가는 재시도 한 번뿐이고
  // 재시도가 실패하면 첫 결과를 그대로 쓰므로 결과가 나빠지지는 않는다.
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9가-힣]+/g) ?? []
  const src = new Set(words(a))
  const out = words(b)
  if (out.length < 20) return false
  const shared = out.filter((w) => src.has(w)).length
  return shared / out.length > 0.85
}

/** 조각 하나당 최대 시도 횟수 (첫 시도 + 재시도 2회) */
const MAX_CHUNK_ATTEMPTS = 3

const RETRY_HINT =
  '\n\n중요: 직전 시도에서 원문을 그대로 복사해 돌려주는 실패가 있었다. ' +
  '이번에는 반드시 지시를 적용한 결과를 내라. 코드 블록 안을 제외한 모든 문장이 바뀌어야 한다.'

/**
 * 문서를 조각으로 나눠 지시를 적용하고 결과를 합친다.
 *
 * mode='transform'  번역·재작성처럼 조각별 결과를 이어 붙이면 되는 작업
 * mode='reduce'     요약·분석처럼 부분 결과를 다시 한 번 합쳐야 하는 작업
 */
export async function runDocumentJob(
  sessionId: string,
  doc: StoredDocument,
  instruction: string,
  mode: 'transform' | 'reduce',
  hooks: DocumentJobHooks
): Promise<DocumentJobResult> {
  const { model, config, profile } = await resolveModelFor('standard')
  const overhead = estimateTokens(TRANSFORM_PROMPT + instruction) + 200
  const chunks = splitIntoChunks(doc.text, chunkBudget(profile, overhead))

  let inputTokens = 0
  let outputTokens = 0
  let unchanged = 0
  const parts: string[] = []

  const runChunk = async (chunk: string, i: number, hint: string): Promise<string> => {
    const { text, usage } = await completeText({
      model,
      // 지시를 시스템 프롬프트 맨 앞에도 둔다 — 규칙 목록에 묻히면 모델이 원문을 그대로 뱉는다
      system: `${instruction}\n\n${TRANSFORM_PROMPT}${hint}`,
      prompt: `## 지시\n${instruction}\n\n## 조각 ${i + 1}/${chunks.length}\n${chunk}`,
      ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {})
    })
    inputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
    return text.trim()
  }

  for (let i = 0; i < chunks.length; i++) {
    if (hooks.signal.aborted) throw new Error('사용자가 중지했습니다.')
    hooks.onProgress(i, chunks.length)
    let out = await runChunk(chunks[i], i, '')
    // 같은 조각이 어떤 때는 처리되고 어떤 때는 원문 그대로 돌아온다. 결과를 보고 다시 시킨다.
    for (let attempt = 1; attempt < MAX_CHUNK_ATTEMPTS && looksUnchanged(chunks[i], out); attempt++) {
      if (hooks.signal.aborted) throw new Error('사용자가 중지했습니다.')
      const retry = await runChunk(chunks[i], i, RETRY_HINT)
      // 재시도가 나아지지 않으면 첫 결과를 유지한다 — 결과가 나빠지지는 않게
      if (!looksUnchanged(chunks[i], retry)) {
        out = retry
        break
      }
      if (attempt === MAX_CHUNK_ATTEMPTS - 1) unchanged++
    }
    parts.push(out)
  }
  hooks.onProgress(chunks.length, chunks.length)

  recordUsage(
    { sessionId, kind: 'chat', provider: config.label, model: config.model, tier: 'standard' },
    { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
  )

  if (mode === 'transform' || parts.length === 1) {
    return { text: parts.join('\n\n'), chunks: chunks.length, unchanged, inputTokens, outputTokens }
  }

  // 요약·분석은 부분 결과를 다시 합친다. 합칠 것들이 또 창을 넘으면 단계적으로 줄인다.
  let pending = parts
  while (pending.length > 1) {
    const groups = splitIntoChunks(pending.join('\n\n---\n\n'), chunkBudget(profile, overhead))
    const next: string[] = []
    for (const group of groups) {
      if (hooks.signal.aborted) throw new Error('사용자가 중지했습니다.')
      const { text, usage } = await completeText({
        model,
        system: REDUCE_PROMPT,
        prompt: `## 원래 지시\n${instruction}\n\n## 부분 결과들\n${group}`,
        ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
        ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {})
      })
      inputTokens += usage.inputTokens ?? 0
      outputTokens += usage.outputTokens ?? 0
      next.push(text.trim())
    }
    // 한 단계에서 줄지 않으면 무한 루프가 되므로 멈춘다
    if (next.length >= pending.length) return { text: next.join('\n\n'), chunks: chunks.length, unchanged, inputTokens, outputTokens }
    pending = next
  }
  return { text: pending[0] ?? '', chunks: chunks.length, unchanged, inputTokens, outputTokens }
}

/**
 * 지시 내용으로 처리 방식을 고른다.
 *
 * 좁은 창의 모델은 mode를 자주 틀리게 고르는데, 틀리면 번역 결과가 요약되어 돌아오는 식으로
 * 결과가 통째로 어긋난다. 집계형 동사가 보일 때만 병합(reduce)으로 가고, 나머지는 이어 붙인다.
 */
export function inferMode(instruction: string): 'transform' | 'reduce' {
  return /요약|정리|분석|추출|비교|목록|리스트|핵심|정리해|summar|analy|extract|outline/i.test(instruction)
    ? 'reduce'
    : 'transform'
}

/** 메인 에이전트에게 노출되는 문서 처리 도구 */
export function documentTools(
  sessionId: string,
  start: (documentId: string, instruction: string, mode: 'transform' | 'reduce') => TaskInfo
): ToolSet {
  return {
    process_document: tool({
      description:
        '모델 창보다 큰 첨부 문서를 조각으로 나눠 지시를 적용하고 결과를 합친다. ' +
        '첨부가 "documentId"와 함께 표시되면 그 문서 전체를 대상으로 하는 작업(번역, 요약, 분석, 재작성)은 ' +
        '직접 하려 하지 말고 반드시 이 도구를 사용하라. 백그라운드로 진행되며 완료되면 결과가 전달된다.',
      inputSchema: z.object({
        documentId: z.string().describe('첨부 표시에 적힌 documentId'),
        skillId: z
          .string()
          .optional()
          .describe(
            '저장된 스킬을 쓸 때 그 skillId. 주면 스킬의 지시문과 방식이 그대로 쓰이고 instruction/mode는 무시된다'
          ),
        instruction: z
          .string()
          .optional()
          .describe('각 조각에 그대로 적용할 지시 (예: "한국어로 번역하라"). 조각 번호나 문서 이름은 넣지 마라'),
        mode: z
          .enum(['transform', 'reduce'])
          .optional()
          .describe(
            'transform=번역·재작성처럼 조각별 결과를 이어 붙이면 되는 작업, reduce=요약·분석처럼 마지막에 합쳐야 하는 작업. ' +
              '생략하면 지시 내용을 보고 자동으로 고른다'
          )
      }),
      execute: async ({ documentId, skillId, instruction, mode }) => {
        const doc = getDocument(documentId)
        if (!doc) return { error: `documentId ${documentId}에 해당하는 문서가 없습니다.` }
        if (doc.sessionId !== sessionId) return { error: '다른 대화의 문서입니다.' }

        // 스킬을 지정하면 다듬어 둔 지시문을 그대로 쓴다 — 매번 새로 쓰면 품질이 흔들린다
        const skill = skillId ? resolveSkill(skillId) : undefined
        if (skillId && !skill) return { error: `skillId ${skillId}에 해당하는 스킬이 없습니다.` }
        const finalInstruction = skill?.instruction ?? instruction
        if (!finalInstruction) return { error: 'skillId 또는 instruction 중 하나는 필요합니다.' }
        const finalMode = skill?.mode ?? mode ?? inferMode(finalInstruction)

        try {
          const info = start(documentId, finalInstruction, finalMode)
          return {
            taskId: info.id,
            status: info.status,
            documentTokens: doc.tokens,
            ...(skill ? { usedSkill: skill.name } : {})
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      }
    })
  }
}

/** 첨부가 창보다 클 때 메시지에 들어갈 안내 — 본문 대신 이것만 넣는다 */
export function documentStub(doc: StoredDocument, previewChars: number): string {
  const preview = doc.text.slice(0, Math.max(0, previewChars))
  return (
    `--- 첨부 파일: ${doc.name} (documentId: ${doc.id}, 약 ${doc.tokens.toLocaleString()}토큰) ---\n` +
    `이 문서는 네 컨텍스트보다 커서 전문이 실려 있지 않다. 아래는 앞부분 미리보기다.\n` +
    `문서 전체를 대상으로 하는 작업(번역·요약·분석)은 process_document(documentId="${doc.id}", ...)로 처리하라. ` +
    `미리보기만 보고 답하거나, 사용자에게 파일을 다시 달라고 하지 마라.\n\n` +
    `${preview}\n--- 미리보기 끝 ---`
  )
}
