import mammoth from 'mammoth'
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

function inline(name: string, body: string): UserPart {
  const truncated = body.length > MAX_INLINE_TEXT ? body.slice(0, MAX_INLINE_TEXT) + '\n...[내용 잘림]' : body
  return { type: 'text', text: `--- 첨부 파일: ${name} ---\n${truncated}\n--- 첨부 끝 ---` }
}

/**
 * 첨부를 모델이 이해할 수 있는 메시지 파트로 변환한다.
 * 이미지/PDF는 멀티모달 파트로 그대로, docx·텍스트류는 본문을 추출해 텍스트로 인라인.
 */
export async function buildAttachmentParts(
  attachments: AttachmentPayload[]
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
        parts.push(inline(att.name, value))
      } catch (e) {
        parts.push({
          type: 'text',
          text: `[첨부 "${att.name}"의 텍스트 추출 실패: ${e instanceof Error ? e.message : String(e)}]`
        })
      }
    } else if (isTextLike(att)) {
      parts.push(inline(att.name, bytes.toString('utf-8')))
    } else {
      parts.push({
        type: 'text',
        text: `[첨부 "${att.name}" (${att.mimeType || '알 수 없는 형식'})은 지원하지 않는 형식이라 내용을 읽지 못했습니다. 이미지, PDF, Word(docx), 텍스트 파일을 지원합니다.]`
      })
    }
  }
  return { parts, metas }
}
