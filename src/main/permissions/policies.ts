import { minimatch } from 'minimatch'
import { homedir } from 'os'
import type { PermissionRule } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'
import { ELEVATED_TOOL_NAME } from './elevation'

/** 세션 규칙은 메모리에만, 영구 규칙은 rules.json에 저장 */
let sessionRules: PermissionRule[] = []

function loadAlways(): PermissionRule[] {
  return readJson<PermissionRule[]>('rules.json', [])
}

function saveAlways(rules: PermissionRule[]): void {
  writeJson('rules.json', rules)
}

export function listRules(): PermissionRule[] {
  return [...loadAlways(), ...sessionRules]
}

export function addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): void {
  // 상승 실행은 어떤 경로로도 미리 허용해 둘 수 없다 — 매번 사람이 그 자리에서 승인해야 한다.
  // 차단 규칙은 막을 이유가 없으므로 허용 규칙만 거부한다.
  if (rule.toolName === ELEVATED_TOOL_NAME && rule.action === 'allow') {
    throw new Error('관리자 권한 실행은 허용 규칙으로 저장할 수 없습니다. 매번 승인이 필요합니다.')
  }
  const full: PermissionRule = { ...rule, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
  if (rule.scope === 'session') {
    sessionRules.push(full)
  } else {
    saveAlways([...loadAlways(), full])
  }
}

export function deleteRule(id: string): void {
  sessionRules = sessionRules.filter((r) => r.id !== id)
  saveAlways(loadAlways().filter((r) => r.id !== id))
}

function expandHome(p: string): string {
  return p.startsWith('~') ? homedir() + p.slice(1) : p
}

/**
 * 패턴 매칭: 경로형 패턴은 글롭, 그 외에는 접두사 매칭.
 * 예) "~/projects/**" ← 파일 도구,  "git *" ← 셸 도구
 */
export function patternMatches(pattern: string, target: string): boolean {
  const pat = expandHome(pattern)
  const tgt = expandHome(target)
  if (pat.includes('/') || pat.includes('\\')) {
    return minimatch(tgt, pat, { dot: true }) || tgt === pat
  }
  if (pat.endsWith('*')) {
    return tgt.startsWith(pat.slice(0, -1))
  }
  return tgt === pat
}

/** deny 규칙 우선 → allow 규칙 → 매칭 없으면 null(사용자에게 질문) */
export function evaluate(toolName: string, target: string): 'allow' | 'deny' | null {
  const rules = listRules().filter((r) => r.toolName === toolName)
  for (const r of rules) {
    if (r.action === 'deny' && patternMatches(r.pattern, target)) return 'deny'
  }
  for (const r of rules) {
    if (r.action === 'allow' && patternMatches(r.pattern, target)) return 'allow'
  }
  return null
}

export function clearSessionRules(): void {
  sessionRules = []
}
