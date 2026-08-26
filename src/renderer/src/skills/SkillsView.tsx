import { useEffect, useState } from 'react'
import type { Skill } from '@shared/types'

type Draft = Pick<Skill, 'name' | 'description' | 'instruction' | 'mode'> & { id?: string }

const emptyDraft = (): Draft => ({ name: '', description: '', instruction: '', mode: 'transform' })

const MODE_LABEL: Record<Skill['mode'], string> = {
  transform: '이어 붙임 (번역·재작성)',
  reduce: '병합 (요약·분석)'
}

/**
 * 스킬 관리 화면.
 *
 * 스킬의 본체는 instruction이다 — 결과가 마음에 들지 않을 때 고치는 곳이 여기이고,
 * 그래서 목록에서 바로 펼쳐 편집할 수 있게 두었다.
 */
export default function SkillsView(): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState(false)

  const refresh = async (): Promise<void> => {
    setSkills(await window.api.listSkills())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim() || !draft.instruction.trim()) return
    await window.api.saveSkill({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      description: draft.description.trim(),
      instruction: draft.instruction.trim(),
      mode: draft.mode
    })
    setDraft(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await window.api.deleteSkill(id)
    if (draft?.id === id) setDraft(null)
    await refresh()
  }

  return (
    <div className="page">
      <h2>스킬</h2>
      <div className="card">
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>
          반복해서 시키는 작업의 지시문을 이름 붙여 고정해 둡니다. 같은 일을 시킬 때마다 모델이
          지시문을 새로 쓰면 결과가 실행마다 달라지는데, 스킬을 쓰면 한 번 다듬은 지시문이 그대로
          적용됩니다. 같은 작업을 두 번째로 수행하면 앱이 자동으로 스킬을 만들고, 여기서 이름과
          지시문을 직접 고칠 수 있습니다.
        </div>
        {skills.length === 0 && (
          <div className="empty">
            아직 스킬이 없습니다. 문서 처리 작업을 두 번 반복하면 자동으로 만들어지거나, 아래에서 직접 추가할 수 있습니다.
          </div>
        )}
        {skills.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>이름</th>
                <th>방식</th>
                <th>출처</th>
                <th>사용</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div>{s.name}</div>
                    <div className="dim" style={{ fontSize: 12 }}>
                      {s.description}
                    </div>
                  </td>
                  <td className="dim">{MODE_LABEL[s.mode]}</td>
                  <td className="dim">{s.source === 'auto' ? '자동 생성' : '직접 추가'}</td>
                  <td className="dim">{s.useCount}회</td>
                  <td>
                    <div className="row">
                      <button
                        onClick={() =>
                          setDraft({
                            id: s.id,
                            name: s.name,
                            description: s.description,
                            instruction: s.instruction,
                            mode: s.mode
                          })
                        }
                      >
                        수정
                      </button>
                      <button className="danger" onClick={() => void remove(s.id)}>
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3>{draft?.id ? '스킬 수정' : '스킬 추가'}</h3>
      <div className="card grid-form">
        <span>이름</span>
        <input
          placeholder="예: 문서 한국어 번역"
          value={draft?.name ?? ''}
          onChange={(e) => setDraft({ ...(draft ?? emptyDraft()), name: e.target.value })}
        />
        <span>설명</span>
        <input
          placeholder="언제 쓰는 스킬인지 — 에이전트가 이 설명을 보고 고릅니다"
          value={draft?.description ?? ''}
          onChange={(e) => setDraft({ ...(draft ?? emptyDraft()), description: e.target.value })}
        />
        <span>방식</span>
        <select
          value={draft?.mode ?? 'transform'}
          onChange={(e) =>
            setDraft({ ...(draft ?? emptyDraft()), mode: e.target.value as Skill['mode'] })
          }
        >
          <option value="transform">{MODE_LABEL.transform}</option>
          <option value="reduce">{MODE_LABEL.reduce}</option>
        </select>
        <span>지시문</span>
        <div>
          <textarea
            style={{ width: '100%', boxSizing: 'border-box', minHeight: 90 }}
            placeholder="조각마다 그대로 적용할 지시. 예: 한국어로 번역하라. 제목과 표 머리글도 빠짐없이 번역하라."
            value={draft?.instruction ?? ''}
            onChange={(e) => setDraft({ ...(draft ?? emptyDraft()), instruction: e.target.value })}
          />
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 6 }}>
            문서를 나눈 각 조각에 이 문장이 그대로 붙습니다. 조각 번호나 문서 이름은 넣지 마세요 —
            앱이 알아서 붙입니다. 결과가 마음에 들지 않으면 여기를 고치는 것이 가장 효과가 큽니다.
          </div>
        </div>
        <span />
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            {draft?.id ? '저장' : '추가'}
          </button>
          {draft && <button onClick={() => setDraft(null)}>취소</button>}
          {saved && <span style={{ color: 'var(--ok)' }}>저장됨</span>}
        </div>
      </div>
    </div>
  )
}
