import { z } from 'zod'
import { exec, execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir, platform } from 'os'
import { isAbsolute, join, resolve } from 'path'
import type { DesktopToolDef } from './defs'
import { decodeText } from './encoding'

const MAX_OUTPUT = 100 * 1024
const isWindows = platform() === 'win32'

/**
 * 실행되는 셸을 도구 설명에 밝힌다 — cmd.exe인 줄 모르면 모델은 POSIX 문법을 보낸다.
 *
 * 유닉스 명령이 있는지는 PATH에 달렸으므로(Git 설치본이 얹히면 ls가 되기도 한다) 단정하지
 * 않는다. /dev/null만은 PATH와 무관하게 없다.
 */
const SHELL_HINT = isWindows
  ? '이 기기는 Windows이고 명령은 cmd.exe로 실행된다 — /dev/null은 없고(2>nul) ls·cat·grep·which 같은 유닉스 명령도 없을 수 있다. dir·type·findstr·where를 쓰거나 powershell -NoProfile -Command "..."로 감싸라. '
  : ''

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

/** 다운로드 명령에서 저장 경로를 뽑는다. curl은 -o/--output만 (-O는 인자를 받지 않는다) */
function outputPath(command: string): string | undefined {
  const flags = /wget\b/.test(command)
    ? /(?:^|\s)(?:-O|--output-document)[=\s]+(\S+)/
    : /(?:^|\s)(?:-o|--output)[=\s]+(\S+)/
  const m = command.match(flags)
  if (!m) return undefined
  return m[1].replace(/^["']|["']$/g, '')
}

/**
 * 종료 코드가 성공을 말할 때 다운로드 결과를 다시 본다.
 *
 * curl·wget은 HTTP 오류를 종료 코드로 알리지 않는다. 404가 와도 -f(--fail) 없이는
 * 종료 코드가 0이고, 서버가 준 오류 본문이 그대로 파일에 저장된다.
 *
 * 실제로 겪은 일이다. 존재하지 않는 릴리스 URL로 디컴파일러를 받으려던 턴에서 curl이
 * "Not Found" 9바이트를 jar로 저장했고, 도구는 exitCode 0을 돌려줬다. 모델은 무엇이
 * 잘못됐는지 알 길이 없어 같은 다운로드를 세 번 되풀이한 뒤 사용자에게 되물으며 턴을
 * 끝냈다 — 44K 토큰을 쓰고 산출물은 없었다. 받은 파일을 직접 확인해서 알려준다.
 */
function downloadNote(command: string, cwd: string): string | undefined {
  if (!/(?:^|[\s|&;(])(?:curl|wget)(?:\.exe)?\s/i.test(command)) return undefined
  // 짧은 플래그는 뭉쳐서 온다 (-fsSL). 클러스터 안의 f도 --fail과 같은 뜻이다.
  const hasFail = /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|--fail\b/.test(command)
  const out = outputPath(command)
  if (!out) {
    return hasFail
      ? undefined
      : 'curl·wget은 -f(--fail) 없이는 404·403에도 종료 코드 0을 낸다. 종료 코드만 보고 성공으로 판단하지 마라.'
  }

  const path = isAbsolute(out) ? out : join(cwd, out)
  if (!existsSync(path)) {
    return `내려받았다는 파일이 없다 (${path}). 종료 코드와 무관하게 다운로드는 실패했다. 같은 URL을 다시 시도하지 말고 URL이 실제로 존재하는지부터 확인하라.`
  }

  const size = statSync(path).size
  // 정상적인 배포 파일이 1KB 미만인 경우는 사실상 없다. 이 크기면 내용은 오류 메시지다.
  if (size >= 1024) return undefined
  let body = ''
  try {
    body = readFileSync(path).toString('utf-8').trim().slice(0, 200)
  } catch {
    /* 못 읽어도 크기만으로 충분히 이상하다 */
  }
  return (
    `받은 파일이 ${size}바이트뿐이다 (${path})${body ? ` — 내용: "${body}"` : ''}. ` +
    '이건 내려받으려던 파일이 아니라 서버가 준 오류 응답이다. ' +
    (hasFail ? '' : 'curl·wget은 -f(--fail) 없이는 HTTP 오류에도 종료 코드 0을 낸다. ') +
    '같은 URL로 다시 시도하지 마라 — URL이 틀렸을 가능성이 높으니 실제 배포 경로부터 확인하라.'
  )
}

/** cmd.exe가 "이런 명령·경로 없다"고 할 때 내는 말 (한국어·영어 로케일) */
const CMD_UNKNOWN =
  /내부 또는 외부 명령|is not recognized as an internal or external command|지정된 경로를 찾을 수 없습니다|The system cannot find the (?:path|file) specified/i

/**
 * Windows에서 POSIX 문법을 쓴 것을 알린다.
 *
 * exec는 Windows에서 cmd.exe를 쓴다. 모델은 `ls -la *.class 2>/dev/null || echo "없음"`
 * 같은 명령을 보내고, cmd는 `2>/dev/null`에서 경로를 못 찾아 실패한 뒤 `||` 뒤의 echo를
 * 실행한다. 그 결과 stdout에는 "없음"이, exitCode에는 0이 담긴다 — 모델은 이것을
 * "파일이 없다"는 확인으로 읽는다. 실제로는 ls가 없었을 뿐이고 파일은 그 자리에 있었다.
 */
function windowsShellNote(command: string, stderr: string): string | undefined {
  if (!isWindows || !CMD_UNKNOWN.test(stderr)) return undefined
  // find는 Windows에도 있는 명령이라 뺀다 — 여기 있는 것은 cmd.exe에 없는 것들뿐이어야 한다
  const posix = /(?:^|[\s|&;(])(ls|cat|grep|head|tail|which|touch|sed|awk|wc|df|du|ps|file|uname)\s/.exec(command)
  const redirect = /2>\s*\/dev\/null|>\s*\/dev\/null/.test(command)
  if (!posix && !redirect) return undefined
  return (
    '이 명령은 cmd.exe에서 돌았고 POSIX 문법은 여기서 동작하지 않는다' +
    (posix ? ` (${posix[1]} 없음` : ' (') +
    (redirect ? `${posix ? ', ' : ''}/dev/null 없음` : '') +
    '). dir·type·findstr·where와 2>nul을 쓰거나, 명령 전체를 powershell -NoProfile -Command "..."로 감싸라. ' +
    '앞선 결과가 "없다"로 나왔더라도 그건 대상이 없다는 뜻이 아니라 명령이 실행되지 않았다는 뜻이다 — 다시 확인하라.'
  )
}

export const shellExec: DesktopToolDef<
  z.ZodObject<{ command: z.ZodString; cwd: z.ZodOptional<z.ZodString> }>
> = {
  name: 'shell_exec',
  description:
    '셸 명령을 실행한다. cwd 미지정 시 홈 디렉토리에서 실행. 타임아웃 120초, 인터랙티브 명령 불가. ' +
    // 어느 셸에서 도는지 모르면 모델은 자기가 익숙한 문법을 쓴다. Windows에서만 이 줄을 낸다 —
    // 좁은 창에서 도구 정의 한 줄은 그대로 대화 기록에서 빠지는 자리다.
    SHELL_HINT +
    'sudo·su·pkexec·runas 등 권한 상승은 이 도구로 할 수 없다(차단됨) — shell_exec_elevated를 쓴다. ' +
    '서비스·서버가 뜨지 않거나 연결되지 않는 문제는 status 명령 결과만으로 판단하지 마라. ' +
    '제품의 로그 파일을 찾아 읽어라 — 상태는 "실행 중"인데 기능 로딩이 실패해 ' +
    '아무것도 서빙하지 않는 경우가 있다.',
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
      const cwd = i.cwd ? expandHome(i.cwd) : homedir()
      const opts = {
        cwd,
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
        const err = truncate(decodeText(stderr))
        // 종료 코드가 성공을 말할 때만 결과를 다시 본다. 이미 실패로 나온 것은 모델이 알고 있다.
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        const note =
          exitCode === 0
            ? windowsShellNote(i.command, err) ?? downloadNote(i.command, cwd)
            : undefined
        resolvePromise({
          exitCode,
          stdout: truncate(decodeText(stdout)),
          stderr: err,
          timedOut: error?.killed === true,
          ...(note ? { note } : {})
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
