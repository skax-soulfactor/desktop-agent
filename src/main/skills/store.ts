import type { ModelTier, Skill } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

/**
 * 스킬 저장소.
 *
 * 스킬은 "반복해서 시키는 작업"을 이름 붙여 고정한 것이다. 같은 일을 시킬 때마다 모델이
 * 지시문을 새로 쓰면 실행마다 결과가 달라진다 — 실제로 "지시를 프롬프트 앞에 둬야 번역이
 * 된다" 같은 조정은 즉흥적으로 쓰인 지시문에서는 재현되지 않는다. 한 번 다듬은 지시문을
 * 그대로 다시 쓰기 위한 장치다.
 *
 * 만들어지는 경로는 둘이다: 사용자가 직접 추가하거나, 앱이 같은 작업의 반복을 관찰하고
 * 자동으로 만든다(recordRun). 자동 생성은 모델의 판단이 아니라 실제 사용 이력에 근거한다.
 */

interface SkillFile {
  skills: Skill[]
  /** 아직 스킬이 되지 못한 실행 이력 — 두 번째 반복에서 스킬로 승격한다 */
  runs: { instruction: string; mode: 'transform' | 'reduce'; at: string }[]
}

const FILE = 'skills.json'
const MAX_RUNS = 50

function load(): SkillFile {
  const raw = readJson<Partial<SkillFile>>(FILE, {})
  return { skills: raw.skills ?? [], runs: raw.runs ?? [] }
}

function save(state: SkillFile): void {
  writeJson(FILE, state)
}

export function listSkills(includeArchived = false): Skill[] {
  return load()
    .skills.filter((s) => includeArchived || s.status === 'active')
    .sort((a, b) => b.useCount - a.useCount || b.updatedAt.localeCompare(a.updatedAt))
}

export function getSkill(id: string): Skill | undefined {
  return load().skills.find((s) => s.id === id)
}

const HANGUL_WORD = /^[가-힣]+$/

/**
 * 한글 단어는 앞 두 음절(어간)만 남긴다.
 * "번역하라 / 번역해줘 / 번역해주세요"는 같은 작업인데 단어를 통째로 비교하면 전부 다르게 잡힌다.
 */
function stem(word: string): string {
  return HANGUL_WORD.test(word) && word.length >= 3 ? word.slice(0, 2) : word
}

/** 지시문에서 의미 있는 단어만 남긴다 (조사·어미 차이로 다른 작업이 되지 않도록) */
function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9가-힣]+/g) ?? []
  return new Set(words.filter((w) => w.length > 1).map(stem))
}

/** 두 지시문이 같은 작업을 뜻하는지 — 단어 겹침 비율로 본다 */
function similar(a: string, b: string): boolean {
  const x = keywords(a)
  const y = keywords(b)
  if (x.size === 0 || y.size === 0) return false
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / Math.max(x.size, y.size) >= 0.6
}

export function findSimilarSkill(instruction: string): Skill | undefined {
  return load().skills.find((s) => s.status === 'active' && similar(s.instruction, instruction))
}

export function createSkill(
  input: Pick<Skill, 'name' | 'description' | 'instruction' | 'mode'> &
    Partial<Pick<Skill, 'tier' | 'source'>>
): Skill {
  const state = load()
  const now = new Date().toISOString()
  const skill: Skill = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    instruction: input.instruction,
    mode: input.mode,
    tier: input.tier,
    source: input.source ?? 'user',
    status: 'active',
    useCount: 0,
    createdAt: now,
    updatedAt: now
  }
  state.skills.push(skill)
  save(state)
  return skill
}

export function updateSkill(id: string, patch: Partial<Omit<Skill, 'id' | 'createdAt'>>): Skill | undefined {
  const state = load()
  const skill = state.skills.find((s) => s.id === id)
  if (!skill) return undefined
  Object.assign(skill, patch, { updatedAt: new Date().toISOString() })
  save(state)
  return skill
}

export function deleteSkill(id: string): boolean {
  const state = load()
  const before = state.skills.length
  state.skills = state.skills.filter((s) => s.id !== id)
  if (state.skills.length === before) return false
  save(state)
  return true
}

/** 지시문에서 스킬 이름을 만든다 (사용자가 나중에 고칠 수 있으므로 규칙 기반으로 충분하다) */
function nameFrom(instruction: string): string {
  const line = instruction.split('\n')[0].trim().replace(/[.。]$/, '')
  return line.length > 40 ? line.slice(0, 40) + '…' : line
}

export interface SkillPromotion {
  skill: Skill
  /** 이번에 새로 만들어졌는지 (알림에 쓴다) */
  created: boolean
}

/**
 * 문서 처리 한 건이 끝나면 호출한다.
 *
 * 이미 같은 작업의 스킬이 있으면 사용 횟수만 올린다. 없으면 실행 이력에 남기고,
 * 같은 작업이 두 번째로 관찰될 때 스킬로 승격한다 — 한 번 해본 작업까지 전부 스킬로
 * 만들면 목록이 금방 쓸모없어진다.
 */
export function recordRun(
  instruction: string,
  mode: 'transform' | 'reduce',
  tier?: ModelTier
): SkillPromotion | null {
  const existing = findSimilarSkill(instruction)
  if (existing) {
    updateSkill(existing.id, {
      useCount: existing.useCount + 1,
      lastUsedAt: new Date().toISOString()
    })
    return { skill: { ...existing, useCount: existing.useCount + 1 }, created: false }
  }

  const state = load()
  const now = new Date().toISOString()
  const priorRun = state.runs.find((r) => similar(r.instruction, instruction))
  if (!priorRun) {
    state.runs.push({ instruction, mode, at: now })
    if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
    save(state)
    return null
  }

  // 두 번째 관찰 — 스킬로 승격하고 이력에서 뺀다
  state.runs = state.runs.filter((r) => r !== priorRun)
  save(state)
  const skill = createSkill({
    name: nameFrom(instruction),
    description: `"${nameFrom(instruction)}" 작업을 문서 전체에 ${
      mode === 'reduce' ? '적용하고 결과를 하나로 합친다' : '조각별로 적용해 이어 붙인다'
    }. 반복 사용이 관찰되어 자동 생성됨.`,
    instruction,
    mode,
    tier,
    source: 'auto'
  })
  updateSkill(skill.id, { useCount: 2, lastUsedAt: now })
  return { skill: { ...skill, useCount: 2 }, created: true }
}

/**
 * 시스템 프롬프트에 넣을 스킬 목록. 한 줄씩이라 좁은 창에서도 부담이 적다.
 * 자주 쓴 순으로 상위 몇 개만 넣는다.
 */
export function buildSkillContext(limit = 8): string {
  const skills = listSkills().slice(0, limit)
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- skillId=${s.id.slice(0, 8)} "${s.name}" — ${s.description}`)
  return (
    '## 저장된 스킬 (반복 작업의 고정된 지시문)\n' +
    lines.join('\n') +
    '\n요청이 이 중 하나에 해당하면 지시문을 새로 쓰지 말고 process_document의 skillId에 그 값을 넘겨라.'
  )
}

/** 프롬프트에는 앞 8자리만 넣으므로, 그 접두어로도 찾을 수 있어야 한다 */
export function resolveSkill(idOrPrefix: string): Skill | undefined {
  const skills = load().skills
  return skills.find((s) => s.id === idOrPrefix) ?? skills.find((s) => s.id.startsWith(idOrPrefix))
}
