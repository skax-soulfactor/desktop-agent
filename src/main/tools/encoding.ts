import { execSync } from 'child_process'
import { platform } from 'os'

/**
 * 시스템 코드페이지로 쓰인 텍스트를 사람이 읽을 수 있게 되돌린다.
 *
 * Windows의 기본 콘솔 도구(tasklist, sc 등)와 여러 제품의 로그 파일은 UTF-8이 아니라 시스템
 * 코드페이지로 기록된다. UTF-8로만 읽으면 한국어 Windows에서 "이미지 이름"이 "?????"로 바뀐다.
 * 다만 git·node처럼 UTF-8로 내보내는 쪽도 섞여 있어 코드페이지를 일괄 적용할 수는 없다.
 * 그래서 UTF-8로 먼저 읽고, 대체 문자(U+FFFD)가 나올 때만 코드페이지로 다시 읽는다.
 *
 * 셸 출력과 파일 읽기가 같은 규칙을 써야 한다 — 한쪽만 고쳐 두면 같은 로그가 도구에 따라
 * 읽히기도 하고 깨지기도 한다(실제로 fs_read만 깨져서 Liberty 로그가 통째로 뭉개졌다).
 */

/** 콘솔 코드페이지 → TextDecoder 라벨. 여기 없는 코드페이지는 UTF-8로 둔다 */
const CODEPAGE_LABEL: Record<string, string> = {
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '866': 'ibm866'
}

let oemLabel: string | null | undefined

/** Windows 콘솔의 기본 코드페이지를 한 번만 알아낸다 (chcp 호출은 깨진 출력이 나올 때만) */
function oemDecoderLabel(): string | null {
  if (oemLabel !== undefined) return oemLabel
  oemLabel = null
  if (platform() === 'win32') {
    try {
      // "Active code page: 949" / "현재 코드 페이지: 949"
      const out = execSync('chcp.com', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
      const cp = out.match(/[0-9]{3,5}/)?.[0]
      if (cp) oemLabel = CODEPAGE_LABEL[cp] ?? null
    } catch {
      // 알아내지 못하면 UTF-8로 둔다 — 진단 실패가 명령 실행이나 파일 읽기를 막으면 안 된다
    }
  }
  return oemLabel
}

export function decodeText(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('�')) return utf8
  const label = oemDecoderLabel()
  if (!label) return utf8
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return utf8
  }
}
