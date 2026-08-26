import mammoth from 'mammoth'
import { documentStub, registerDocument } from './documents'
import { estimateTokens } from '../llm/profile'
import type { AttachmentMeta, AttachmentPayload } from '@shared/types'

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_INLINE_TEXT = 50_000

/**
 * AI SDK v5 user 메시지 콘텐츠 파트.
 * 이미지/파일 데이터는 base64 문자열로 넣는다 — 세션이 JSON으로 영속되므로
 * Uint8Array는 저장/복원 과정에서 깨진다 (SDK는 base64 문자열을 그대로 지원).
 */
export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string }
  | { type: 'file'; data: string; mediaType: string; filename?: string }

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml|html|log|ts|js|py|java|c|cpp|sh)$/i

function isTextLike(att: AttachmentPayload): boolean {
  return (
    att.mimeType.startsWith('text/') ||
    ['application/json', 'application/xml'].includes(att.mimeType) ||
    TEXT_EXTENSIONS.test(att.name)
  )
}

function isDocx(att: AttachmentPayload): boolean {
  return (
    att.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(att.name)
  )
}

/**
 * 추출한 본문을 메시지에 넣는다.
 *
 * 창에 들어가면 전문을 그대로 인라인한다. 넘치면 자르지 않고 문서로 보관한 뒤
 * 안내와 미리보기만 넣는다 — 모델이 process_document로 조각내어 처리할 수 있게 하기 위해서다.
 * 잘라서 보내면 뒷부분은 존재조차 알 수 없게 된다.
 */
function inlineOrStore(ctx: BuildContext, name: string, body: string): UserPart {
  const budget = ctx.inlineTokenBudget
  if (budget === undefined || estimateTokens(body) <= budget) {
    const truncated = body.length > MAX_INLINE_TEXT ? body.slice(0, MAX_INLINE_TEXT) + '\n...[내용 잘림]' : body
    return { type: 'text', text: `--- 첨부 파일: ${name} ---\n${truncated}\n--- 첨부 끝 ---` }
  }
  const doc = registerDocument(ctx.sessionId, name, body)
  // 미리보기는 예산의 일부만 — 미리보기까지 창을 채우면 처리할 자리가 없다
  return { type: 'text', text: documentStub(doc, Math.floor(budget * 1.6 * 0.4)) }
}

export interface BuildContext {
  sessionId: string
  /** 첨부 본문을 그대로 실을 수 있는 토큰 한도. undefined면 제한 없음(클라우드 모델) */
  inlineTokenBudget?: number
}

/**
 * 첨부 파트와 사용자 문장을 한 메시지의 content로 합친다.
 *
 * 텍스트만 있으면 파트 배열이 아니라 문자열 하나로 보낸다. Ollama의 OpenAI 호환
 * 엔드포인트는 내용이 커지면 여러 개로 나뉜 텍스트 파트를 통째로 버린다 — 실측:
 * 40,650자 첨부를 파트 두 개로 보내면 서버가 받은 프롬프트가 19토큰이었고
 * (모델은 "첨부파일이 없습니다"라고 답한다), 같은 내용을 문자열 하나로 보내면
 * 4,098토큰으로 정상 처리됐다. 이미지·PDF가 섞였을 때만 배열을 유지한다.
 */
export function buildUserContent(parts: UserPart[], userText: string): string | UserPart[] {
  const all: UserPart[] = [...parts, { type: 'text', text: userText }]
  if (all.every((p) => p.type === 'text')) {
    return all.map((p) => (p as { text: string }).text).join('\n\n')
  }
  // 비텍스트 파트는 그대로 두고, 연속된 텍스트만 하나로 접는다
  const merged: UserPart[] = []
  for (const part of all) {
    const prev = merged[merged.length - 1]
    if (part.type === 'text' && prev?.type === 'text') prev.text += `\n\n${part.text}`
    else merged.push(part.type === 'text' ? { ...part } : part)
  }
  return merged
}

/**
 * 첨부를 모델이 이해할 수 있는 메시지 파트로 변환한다.
 * 이미지/PDF는 멀티모달 파트로 그대로, docx·텍스트류는 본문을 추출해 텍스트로 인라인.
 */
export async function buildAttachmentParts(
  attachments: AttachmentPayload[],
  ctx: BuildContext
): Promise<{ parts: UserPart[]; metas: AttachmentMeta[] }> {
  const parts: UserPart[] = []
  const metas: AttachmentMeta[] = []

  for (const att of attachments) {
    metas.push({ name: att.name, mimeType: att.mimeType })
    const bytes = Buffer.from(att.dataBase64, 'base64')

    if (bytes.byteLength > MAX_FILE_BYTES) {
      parts.push({ type: 'text', text: `[첨부 "${att.name}"은 15MB를 초과해 읽지 못했습니다.]` })
      continue
    }

    if (att.mimeType.startsWith('image/')) {
      parts.push({ type: 'image', image: att.dataBase64, mediaType: att.mimeType })
    } else if (att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.name)) {
      parts.push({
        type: 'file',
        data: att.dataBase64,
        mediaType: 'application/pdf',
        filename: att.name
      })
    } else if (isDocx(att)) {
      try {
        const { value } = await mammoth.extractRawText({ buffer: bytes })
        parts.push(inlineOrStore(ctx, att.name, value))
      } catch (e) {
        parts.push({
          type: 'text',
          text: `[첨부 "${att.name}"의 텍스트 추출 실패: ${e instanceof Error ? e.message : String(e)}]`
        })
      }
    } else if (isTextLike(att)) {
      parts.push(inlineOrStore(ctx, att.name, bytes.toString('utf-8')))
    } else {
      parts.push({
        type: 'text',
        text: `[첨부 "${att.name}" (${att.mimeType || '알 수 없는 형식'})은 지원하지 않는 형식이라 내용을 읽지 못했습니다. 이미지, PDF, Word(docx), 텍스트 파일을 지원합니다.]`
      })
    }
  }
  return { parts, metas }
}
