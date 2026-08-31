import { z } from 'zod'
import { exec, execFile, execSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, resolve } from 'path'
import type { DesktopToolDef } from './defs'

const MAX_OUTPUT = 100 * 1024

/**
 * Linux에서는 셸 명령을 no_new_privs 아래에서 실행한다. 이 플래그가 걸린 프로세스와 그 모든
 * 자식은 setuid 비트로 권한을 얻지 못하므로, sudo 바이너리가 실행되더라도 root가 될 수 없다.
 *
 * 게이트웨이의 문자열 차단만으로는 부족하다는 게 실제로 드러났다 — 차단당한 에이전트가
 * `su''do`로 인용을 쪼개 통과했다. 문자열 검사는 언제나 우회 가능하지만 이건 커널이 강제한다.
 *
 * 대가: 파일 capability에 의존하는 명령(예: ping의 CAP_NET_RAW)도 함께 막힌다. shell_exec은
 * 읽기 전용 확인용이고 권한이 필요한 일은 shell_exec_elevated로 가므로 치를 만한 값이다.
 * 상승 경로는 이 함수를 지나지 않아 영향을 받지 않는다(tools/elevated.ts의 pkexec 직접 호출).
 */
const SETPRIV = '/usr/bin/setpriv'
const useNoNewPrivs = platform() === 'linux' && existsSync(SETPRIV)

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p)
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...[출력 잘림]' : s
}

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
      const cp = out.match(/(\d{3,5})/)?.[1]
      if (cp) oemLabel = CODEPAGE_LABEL[cp] ?? null
    } catch {
      // 알아내지 못하면 UTF-8로 둔다 — 진단 실패가 명령 실행을 막으면 안 된다
    }
  }
  return oemLabel
}

/**
 * 명령 출력을 문자열로 만든다.
 *
 * Windows의 기본 콘솔 도구(tasklist, sc, systeminfo 등)는 UTF-8이 아니라 시스템 코드페이지로
 * 출력한다. 한국어 Windows에서 "이미지 이름"이 "�̹��� �̸�"로 모델에 전달되던 원인이다.
 * 다만 git·node처럼 UTF-8로 내보내는 도구도 섞여 있어 코드페이지를 일괄 적용할 수는 없다.
 * 그래서 UTF-8로 먼저 읽고, 대체 문자(U+FFFD)가 나올 때만 코드페이지로 다시 읽는다.
 */
function decodeOutput(buf: Buffer | string): string {
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

export const shellExec: DesktopToolDef<
  z.ZodObject<{ command: z.ZodString; cwd: z.ZodOptional<z.ZodString> }>
> = {
  name: 'shell_exec',
  description:
    '셸 명령을 실행한다. cwd 미지정 시 홈 디렉토리에서 실행. 타임아웃 120초, 인터랙티브 명령 불가. ' +
    'sudo·su·pkexec·runas 등 권한 상승은 이 도구로 할 수 없다(차단됨) — shell_exec_elevated를 쓴다.',
  risk: 'execute',
  inputSchema: z.object({
    command: z.string(),
    cwd: z.string().optional().describe('작업 디렉토리 (절대 경로 또는 ~)')
  }),
  describeCall: (i) => `셸 실행: ${i.command}${i.cwd ? ` (cwd: ${i.cwd})` : ''}`,
  targetOf: (i) => i.command,
  suggestedPattern: (i) => {
    const first = i.command.trim().split(/\s+/)[0] ?? ''
    return first ? `${first} *` : i.command
  },
  execute(i) {
    return new Promise((resolvePromise) => {
      const opts = {
        cwd: i.cwd ? expandHome(i.cwd) : homedir(),
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
        // 디코딩은 decodeOutput이 맡는다 — 코드페이지를 보고 정해야 해서 여기서 문자열로 받으면 늦다
        encoding: 'buffer' as const
      }
      // execFile은 실행 자체가 실패하면 code에 문자열(ENOENT 등)을 담는다 — 숫자일 때만 종료 코드다
      const done = (
        error: (Error & { code?: string | number | null; killed?: boolean }) | null,
        stdout: Buffer | string,
        stderr: Buffer | string
      ): void => {
        resolvePromise({
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: truncate(decodeOutput(stdout)),
          stderr: truncate(decodeOutput(stderr)),
          timedOut: error?.killed === true
        })
      }
      if (useNoNewPrivs) {
        execFile(SETPRIV, ['--no-new-privs', '/bin/sh', '-c', i.command], opts, done)
      } else {
        exec(i.command, opts, done)
      }
    })
  }
}
