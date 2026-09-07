import mammoth from 'mammoth'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { documentStub, registerDocument } from './documents'
import { estimateTokens } from '../llm/profile'
import { dataDir } from '../storage/jsonStore'
import type { AttachmentMeta, AttachmentPayload } from '@shared/types'

/** 이 크기를 넘으면 본문을 메시지에 싣지 않는다. 파일 자체는 크기와 무관하게 디스크에 쓴다 */
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

/** 대화별 첨부 원본 보관 디렉토리 */
export function attachmentDir(sessionId: string): string {
  return join(dataDir(), 'attachments', sessionId)
}

/**
 * 첨부 이름은 사용자가 고른 값이고 경로로 쓰기에는 신뢰할 수 없다.
 * 디렉토리 성분과 상위 이동(..), Windows에서 금지된 문자를 걷어내고 파일명만 남긴다.
 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'attachment'
}

/**
 * 첨부 원본을 디스크에 쓰고 절대 경로를 돌려준다.
 *
 * 이게 없어서 실제로 막힌 적이 있다. `.class` 파일을 붙이고 "디컴파일 해줘"라고 하면
 * 모델에게는 "지원하지 않는 형식"이라는 문장 한 줄만 갔고 파일은 어디에도 없었다.
 * 모델은 첨부 이름을 cwd의 파일처럼 여겨 javap를 부르고, 없다는 답을 받고, 디컴파일러를
 * 내려받으려다 실패하고, 결국 44K 토큰을 쓰고 "파일을 다시 올려 달라"로 끝났다.
 *
 * 형식을 얼마나 지원하느냐와 무관하게, 첨부는 도구가 열 수 있는 실체로 남아야 한다.
 * 모델이 내용을 읽지 못하는 형식일수록 셸 도구로 넘길 경로가 더 필요하다.
 *
 * 같은 이름이 다시 오면 덮어쓴다 — 같은 대화에서 같은 이름을 다시 올렸다면 새것이 대상이다.
 */
function saveAttachmentFile(sessionId: string, name: string, bytes: Buffer): string | null {
  try {
    const dir = attachmentDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, safeFileName(name))
    writeFileSync(path, bytes)
    return path
  } catch {
    // 디스크에 못 써도 인라인 경로는 살아 있어야 한다 — 경로 안내만 빠진다
    return null
  }
}

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
 * 저장된 첨부 경로를 한 블록으로 안내한다.
 *
 * 첨부마다 한 줄씩 흩어 놓지 않고 끝에 한 번만 붙인다 — 좁은 창에서 첨부 개수만큼
 * 안내가 불어나면 정작 처리할 내용이 밀린다.
 */
function pathsNote(saved: { name: string; path: string }[]): UserPart {
  return {
    type: 'text',
    text:
      `--- 첨부 원본 파일 ---\n` +
      saved.map((s) => `${s.name} → ${s.path}`).join('\n') +
      `\n이 경로들은 실제로 존재하는 파일이다. 내용이 위에 실리지 않은 첨부라도 ` +
      `fs_read·shell_exec으로 이 경로를 열어 처리하라. 첨부 이름만으로 명령을 만들지 말고 ` +
      `(작업 디렉토리에는 없다) 위 절대 경로를 그대로 써라. 사용자에게 파일을 다시 올려 달라고 하지 마라.\n` +
      `--- 첨부 원본 끝 ---`
  }
}

/**
 * 첨부를 모델이 이해할 수 있는 메시지 파트로 변환한다.
 * 이미지/PDF는 멀티모달 파트로 그대로, docx·텍스트류는 본문을 추출해 텍스트로 인라인.
 *
 * 형식과 무관하게 원본은 항상 디스크에 쓰고 경로를 알린다 — saveAttachmentFile 참고.
 */
export async function buildAttachmentParts(
  attachments: AttachmentPayload[],
  ctx: BuildContext
): Promise<{ parts: UserPart[]; metas: AttachmentMeta[] }> {
  const parts: UserPart[] = []
  const metas: AttachmentMeta[] = []
  const saved: { name: string; path: string }[] = []

  for (const att of attachments) {
    metas.push({ name: att.name, mimeType: att.mimeType })
    const bytes = Buffer.from(att.dataBase64, 'base64')

    // 인라인 여부와 무관하게 먼저 디스크에 쓴다. 모델이 읽지 못하는 형식일수록 경로가 답이다.
    const path = saveAttachmentFile(ctx.sessionId, att.name, bytes)
    if (path) saved.push({ name: att.name, path })

    if (bytes.byteLength > MAX_FILE_BYTES) {
      parts.push({
        type: 'text',
        text: path
          ? `[첨부 "${att.name}"은 15MB를 초과해 본문을 싣지 않았다. 파일은 아래 경로에 있으니 도구로 열어 처리하라.]`
          : `[첨부 "${att.name}"은 15MB를 초과해 읽지 못했습니다.]`
      })
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
        text: path
          ? `[첨부 "${att.name}" (${att.mimeType || '알 수 없는 형식'})은 네가 직접 읽을 수 있는 형식이 아니다. ` +
            `아래 경로에 실제 파일이 있으니 도구로 열어 처리하라 — 형식을 확인하고(file·head), ` +
            `필요하면 그 형식에 맞는 명령을 쓰면 된다. 못 한다고 답하기 전에 파일을 먼저 봐라.]`
          : `[첨부 "${att.name}" (${att.mimeType || '알 수 없는 형식'})은 지원하지 않는 형식이라 내용을 읽지 못했습니다. 이미지, PDF, Word(docx), 텍스트 파일을 지원합니다.]`
      })
    }
  }
  if (saved.length > 0) parts.push(pathsNote(saved))
  return { parts, metas }
}
