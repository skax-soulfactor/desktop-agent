import { z } from 'zod'
import { execFile } from 'child_process'
import { platform, tmpdir } from 'os'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { DesktopToolDef } from './defs'

/**
 * 관리자 권한이 필요한 작업을 OS의 상승 대화상자를 통해 1회 실행한다.
 *
 * 이 앱 프로세스는 처음부터 끝까지 일반 사용자 권한으로 남는다. root가 되는 것은
 * pkexec/UAC/Authorization Services가 띄워 주는 자식 프로세스 하나뿐이고, 그 프로세스는
 * 승인된 argv를 실행하고 죽는다. 비밀번호는 OS가 직접 받으므로 앱 메모리에 들어오지 않는다.
 *
 * 입력이 자유 문자열이 아니라 작업(op) 목록인 이유: 승인 화면에 뜬 글자와 실제 실행되는 것이
 * 1:1이어야 사용자가 판단할 수 있다. 컴파일 결과는 argv 배열이고 셸을 거치지 않으므로,
 * 인자에 `;`나 `$(...)`가 들어 있어도 해석되지 않고 문자열로 전달된다.
 *
 * 설계 근거: docs/DESIGN-PRIVILEGE-ELEVATION.md
 */

const MAX_OUTPUT = 100 * 1024
/** 인증 대화상자 응답 시간까지 포함한 전체 상한 */
const RUN_TIMEOUT_MS = 5 * 60 * 1000

/** 셸 메타문자·공백·제어문자가 없는 이름만 허용 — 승인 화면 한 줄 = 인자 하나를 유지한다 */
const PKG_NAME = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+@-]*$/, '패키지 이름에 쓸 수 없는 문자가 있습니다')
const UNIT_NAME = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/, '서비스 이름에 쓸 수 없는 문자가 있습니다')
// 셸을 거치지 않으므로 ~ 는 확장되지 않는다. 홈 경로가 필요하면 에이전트가 펼쳐서 넘겨야 한다.
const ABS_PATH = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\/])[^\n\r\0]*$/, '절대 경로여야 합니다 (~ 는 확장되지 않습니다)')
const ARG = z.string().min(1).regex(/^[^\n\r\0]+$/, '인자에 줄바꿈이나 NUL을 넣을 수 없습니다')

const elevatedInput = z.object({
  op: z.enum(['package_install', 'package_remove', 'package_update', 'service', 'copy_file', 'raw']),
  names: z.array(PKG_NAME).min(1).max(20).optional().describe('package_* op의 패키지 이름들'),
  action: z
    .enum(['start', 'stop', 'restart', 'status', 'enable', 'disable'])
    .optional()
    .describe('service op의 동작'),
  unit: UNIT_NAME.optional().describe('service op의 서비스/유닛 이름'),
  from: ABS_PATH.optional().describe('copy_file op의 원본 경로'),
  to: ABS_PATH.optional().describe('copy_file op의 대상 경로'),
  argv: z
    .array(ARG)
    .min(1)
    .max(40)
    .optional()
    .describe('raw op의 인자 배열. argv[0]은 실행 파일, 나머지는 인자 하나당 원소 하나 (셸을 거치지 않는다)')
})

export type ElevatedInput = z.infer<typeof elevatedInput>

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`${field} 인자가 필요합니다.`)
  return value
}

/** 설치돼 있는 첫 패키지 관리자 */
function linuxPackageManager(): 'apt-get' | 'dnf' | 'pacman' | 'zypper' {
  for (const [bin, name] of [
    ['/usr/bin/apt-get', 'apt-get'],
    ['/usr/bin/dnf', 'dnf'],
    ['/usr/bin/pacman', 'pacman'],
    ['/usr/bin/zypper', 'zypper']
  ] as const) {
    if (existsSync(bin)) return name
  }
  throw new Error('지원하는 패키지 관리자를 찾지 못했습니다 (apt-get/dnf/pacman/zypper).')
}

function linuxArgv(i: ElevatedInput): string[] {
  switch (i.op) {
    case 'package_install':
    case 'package_remove': {
      const names = need(i.names, 'names')
      const install = i.op === 'package_install'
      switch (linuxPackageManager()) {
        case 'apt-get':
          return ['apt-get', install ? 'install' : 'remove', '-y', ...names]
        case 'dnf':
          return ['dnf', install ? 'install' : 'remove', '-y', ...names]
        case 'pacman':
          return ['pacman', install ? '-S' : '-R', '--noconfirm', ...names]
        case 'zypper':
          return ['zypper', '--non-interactive', install ? 'install' : 'remove', ...names]
      }
      break
    }
    case 'package_update':
      switch (linuxPackageManager()) {
        case 'apt-get':
          return ['apt-get', 'update']
        case 'dnf':
          // 갱신 대상이 있으면 종료 코드 100을 낸다 — 오류가 아니다
          return ['dnf', 'check-update']
        case 'pacman':
          // pacman -Sy 단독은 부분 업그레이드로 시스템을 깨뜨릴 수 있다(Arch 권고).
          // 목록만 갱신하는 안전한 형태가 없으므로 이 op는 제공하지 않는다.
          throw new Error(
            'pacman에서는 목록만 갱신할 수 없습니다(-Sy 단독은 부분 업그레이드 위험). ' +
              '전체 업그레이드가 필요하면 raw op로 ["pacman","-Syu","--noconfirm"]을 요청하고, ' +
              '사용자에게 전체 업그레이드임을 먼저 알려라.'
          )
        case 'zypper':
          return ['zypper', 'refresh']
      }
      break
    case 'service':
      return ['systemctl', need(i.action, 'action'), need(i.unit, 'unit')]
    case 'copy_file':
      return ['cp', '-f', need(i.from, 'from'), need(i.to, 'to')]
    case 'raw':
      return need(i.argv, 'argv')
  }
  throw new Error(`이 플랫폼에서 지원하지 않는 작업입니다: ${i.op}`)
}

function macArgv(i: ElevatedInput): string[] {
  const target = (): string => `system/${need(i.unit, 'unit')}`
  switch (i.op) {
    case 'package_install':
    case 'package_remove':
    case 'package_update':
      throw new Error(
        'macOS의 Homebrew는 관리자 권한이 필요 없습니다. shell_exec로 brew를 그대로 실행하세요.'
      )
    case 'service':
      switch (need(i.action, 'action')) {
        case 'status':
          return ['launchctl', 'print', target()]
        case 'start':
          return ['launchctl', 'kickstart', target()]
        case 'restart':
          return ['launchctl', 'kickstart', '-k', target()]
        case 'stop':
          return ['launchctl', 'kill', 'SIGTERM', target()]
        case 'enable':
          return ['launchctl', 'enable', target()]
        case 'disable':
          return ['launchctl', 'disable', target()]
      }
      break
    case 'copy_file':
      return ['cp', '-f', need(i.from, 'from'), need(i.to, 'to')]
    case 'raw':
      return need(i.argv, 'argv')
  }
  throw new Error(`이 플랫폼에서 지원하지 않는 작업입니다: ${i.op}`)
}

function winArgv(i: ElevatedInput): string[] {
  switch (i.op) {
    case 'package_install':
    case 'package_remove': {
      const names = need(i.names, 'names')
      if (names.length > 1) throw new Error('winget은 한 번에 한 패키지만 처리합니다.')
      return [
        'winget',
        i.op === 'package_install' ? 'install' : 'uninstall',
        '--silent',
        '--accept-source-agreements',
        ...(i.op === 'package_install' ? ['--accept-package-agreements'] : []),
        '--id',
        names[0]
      ]
    }
    case 'package_update':
      return ['winget', 'source', 'update']
    case 'service': {
      const unit = need(i.unit, 'unit')
      const action = need(i.action, 'action')
      const map: Record<string, string[]> = {
        start: ['sc.exe', 'start', unit],
        stop: ['sc.exe', 'stop', unit],
        status: ['sc.exe', 'query', unit],
        restart: ['powershell.exe', '-NoProfile', '-Command', `Restart-Service -Name ${unit}`],
        enable: ['sc.exe', 'config', unit, 'start=', 'auto'],
        disable: ['sc.exe', 'config', unit, 'start=', 'disabled']
      }
      return map[action]
    }
    case 'copy_file':
      return [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `Copy-Item -LiteralPath '${need(i.from, 'from')}' -Destination '${need(i.to, 'to')}' -Force`
      ]
    case 'raw':
      return need(i.argv, 'argv')
  }
  throw new Error(`이 플랫폼에서 지원하지 않는 작업입니다: ${i.op}`)
}

/** op를 이 플랫폼의 argv로 컴파일한다. 승인 화면에 보여줄 값이므로 실행 전에 미리 부른다. */
export function compileArgv(i: ElevatedInput): string[] {
  if (platform() === 'win32') return winArgv(i)
  if (platform() === 'darwin') return macArgv(i)
  return linuxArgv(i)
}

export interface ElevatedResult {
  exitCode: number
  stdout: string
  stderr: string
  argv: string[]
  cancelled?: boolean
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...[출력 잘림]' : s
}

function run(
  file: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // execFile은 종료 코드를 error.code에 숫자로 담는다 (실행 자체가 실패하면 문자열 코드)
        const err = error as (Error & { code?: number | string }) | null
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/** POSIX 셸 작은따옴표 인용 — macOS의 do shell script 경로에서만 쓴다 */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** PATH 해석을 pkexec에 맡기지 않고 미리 절대 경로로 바꾼다 — 승인 화면과 실행 대상을 일치시킨다 */
async function resolveBinary(name: string): Promise<string | null> {
  if (name.startsWith('/')) return existsSync(name) ? name : null
  const { code, stdout } = await run('/usr/bin/which', [name])
  const path = stdout.split('\n')[0]?.trim()
  return code === 0 && path ? path : null
}

async function runLinux(argv: string[]): Promise<ElevatedResult> {
  const bin = await resolveBinary(argv[0])
  if (!bin) {
    return { exitCode: 127, stdout: '', stderr: `실행 파일을 찾을 수 없습니다: ${argv[0]}`, argv }
  }
  // --disable-internal-agent: 데스크톱 polkit 에이전트가 없으면 tty 폴백으로 매달리지 않고 즉시 실패한다.
  // 앱이 비밀번호를 대신 묻는 경로는 존재하지 않는다 (설계 규칙 1).
  const { code, stdout, stderr } = await run('pkexec', [
    '--disable-internal-agent',
    bin,
    ...argv.slice(1)
  ])
  if (code === 126) {
    return {
      exitCode: 126,
      stdout: '',
      stderr: '사용자가 인증을 취소했거나 권한이 거부되었습니다.',
      argv,
      cancelled: true
    }
  }
  if (code === 127 && !stdout) {
    return {
      exitCode: 127,
      stdout: '',
      stderr:
        `실행 파일을 찾지 못했거나 polkit 인증 에이전트가 없습니다 (${argv[0]}). ` +
        '데스크톱 세션 밖이라면 터미널에서 직접 실행해야 합니다.',
      argv
    }
  }
  return { exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr), argv }
}

async function runMac(argv: string[]): Promise<ElevatedResult> {
  // Authorization Services 경로는 argv가 아니라 셸 문자열을 받는다. 각 인자를 작은따옴표로
  // 감싸 셸 해석을 막고, 그 결과를 다시 AppleScript 문자열로 이스케이프한다.
  const command = argv.map(shQuote).join(' ') + ' 2>&1; echo "__EXIT__$?"'
  const applescript = `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`
  const { code, stdout, stderr } = await run('osascript', ['-e', applescript])
  if (code !== 0 && /-128|User canceled/i.test(stderr)) {
    return { exitCode: 126, stdout: '', stderr: '사용자가 인증을 취소했습니다.', argv, cancelled: true }
  }
  const m = /__EXIT__(\d+)\s*$/.exec(stdout)
  const body = m ? stdout.slice(0, m.index) : stdout
  return {
    exitCode: m ? Number(m[1]) : code,
    stdout: truncate(body),
    stderr: truncate(stderr),
    argv
  }
}

async function runWindows(argv: string[]): Promise<ElevatedResult> {
  // Start-Process -Verb RunAs는 파이프 리다이렉션과 함께 쓸 수 없어, 상승된 자식이 임시 파일에
  // 출력을 남기고 이쪽에서 읽는다. 읽은 뒤 바로 지운다.
  const stamp = `agent-elev-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const outFile = join(tmpdir(), `${stamp}.out`)
  const codeFile = join(tmpdir(), `${stamp}.code`)
  const psList = argv
    .slice(1)
    .map((a) => `'${a.replace(/'/g, "''")}'`)
    .join(',')
  const inner =
    `$ErrorActionPreference='Continue'; ` +
    `& '${argv[0].replace(/'/g, "''")}' ${psList ? `@(${psList})` : ''} *> '${outFile}'; ` +
    `Set-Content -LiteralPath '${codeFile}' -Value $LASTEXITCODE`
  const encoded = Buffer.from(inner, 'utf16le').toString('base64')
  const launcher =
    `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`

  const { code, stderr } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    launcher
  ])

  const readAndRemove = (p: string): string => {
    if (!existsSync(p)) return ''
    const text = readFileSync(p, 'utf-8')
    try {
      rmSync(p)
    } catch {
      /* 지우지 못해도 결과 반환은 계속한다 */
    }
    return text
  }
  const stdout = readAndRemove(outFile)
  const exitText = readAndRemove(codeFile).trim()

  if (code !== 0 && !exitText) {
    return {
      exitCode: 126,
      stdout: '',
      stderr: stderr.trim() || 'UAC 승격이 거부되었거나 취소되었습니다.',
      argv,
      cancelled: true
    }
  }
  return {
    exitCode: exitText ? Number(exitText) || 0 : code,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    argv
  }
}

/** 승인이 끝난 argv를 OS 상승 경로로 1회 실행한다 */
export async function runElevated(argv: string[]): Promise<ElevatedResult> {
  if (platform() === 'win32') return runWindows(argv)
  if (platform() === 'darwin') return runMac(argv)
  return runLinux(argv)
}

function describe(i: ElevatedInput): string {
  switch (i.op) {
    case 'package_install':
      return `관리자 권한 패키지 설치: ${(i.names ?? []).join(', ')}`
    case 'package_remove':
      return `관리자 권한 패키지 제거: ${(i.names ?? []).join(', ')}`
    case 'package_update':
      return '관리자 권한 패키지 목록 갱신'
    case 'service':
      return `관리자 권한 서비스 ${i.action}: ${i.unit}`
    case 'copy_file':
      return `관리자 권한 파일 복사: ${i.from} → ${i.to}`
    case 'raw':
      return `관리자 권한 실행: ${(i.argv ?? []).join(' ')}`
  }
}

export const shellExecElevated: DesktopToolDef<typeof elevatedInput> = {
  name: 'shell_exec_elevated',
  description:
    '관리자(root) 권한이 필요한 작업을 1회 실행한다. OS 인증 창이 떠서 사용자가 직접 비밀번호를 ' +
    '입력해야 하며, 사용자가 화면 앞에 있을 때만 쓸 수 있다(스케줄·위임 작업에서는 실패한다). ' +
    '매번 사용자 승인이 필요하므로 꼭 필요한 경우에만, 한 번에 하나씩 요청하라. ' +
    '권한이 필요 없는 명령은 shell_exec를 쓴다.',
  risk: 'elevate',
  inputSchema: elevatedInput,
  describeCall: describe,
  targetOf: (i) => {
    try {
      return compileArgv(i).join(' ')
    } catch {
      return describe(i)
    }
  },
  // 상승은 규칙으로 저장되지 않는다 — 이 값은 쓰이지 않지만 인터페이스상 필요하다
  suggestedPattern: () => '(권한 상승은 규칙으로 저장할 수 없습니다)',
  argvOf: (i) => compileArgv(i),
  execute: (i) => runElevated(compileArgv(i))
}
