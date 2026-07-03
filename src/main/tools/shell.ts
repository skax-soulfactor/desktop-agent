import { z } from 'zod'
import { exec } from 'child_process'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { DesktopToolDef } from './defs'

const MAX_OUTPUT = 100 * 1024

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p)
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...[출력 잘림]' : s
}

export const shellExec: DesktopToolDef<
  z.ZodObject<{ command: z.ZodString; cwd: z.ZodOptional<z.ZodString> }>
> = {
  name: 'shell_exec',
  description:
    '셸 명령을 실행한다. cwd 미지정 시 홈 디렉토리에서 실행. 타임아웃 120초, 인터랙티브 명령 불가.',
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
      exec(
        i.command,
        {
          cwd: i.cwd ? expandHome(i.cwd) : homedir(),
          timeout: 120_000,
          maxBuffer: 5 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          resolvePromise({
            exitCode: error ? (error.code ?? 1) : 0,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            timedOut: error?.killed === true
          })
        }
      )
    })
  }
}
