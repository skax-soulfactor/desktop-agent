import { useEffect, useState } from 'react'
import type { AuditRecord, PermissionRule, ProviderConfig, ProviderType } from '@shared/types'

const TYPE_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'ollama', label: 'Ollama (로컬)' },
  { value: 'openai-compatible', label: 'OpenAI 호환 API' }
]

const DEFAULT_MODEL: Record<ProviderType, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
  ollama: 'llama3.1',
  'openai-compatible': ''
}

const emptyForm = (): ProviderConfig & { apiKey: string } => ({
  id: crypto.randomUUID(),
  type: 'anthropic',
  label: '',
  model: DEFAULT_MODEL.anthropic,
  baseURL: '',
  apiKey: ''
})

export default function SettingsView(): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [rules, setRules] = useState<PermissionRule[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [saved, setSaved] = useState(false)

  const refresh = async (): Promise<void> => {
    const p = await window.api.listProviders()
    setProviders(p.providers)
    setActiveId(p.activeId)
    setRules(await window.api.listRules())
    setAudit(await window.api.listAudit())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const needsBaseURL = form.type === 'ollama' || form.type === 'openai-compatible'
  const needsKey = form.type !== 'ollama'

  const save = async (): Promise<void> => {
    if (!form.label || !form.model) return
    await window.api.saveProvider(
      {
        id: form.id,
        type: form.type,
        label: form.label,
        model: form.model,
        baseURL: form.baseURL || undefined
      },
      form.apiKey || undefined
    )
    setForm(emptyForm())
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    await refresh()
  }

  return (
    <div className="page">
      <h2>LLM 프로바이더</h2>
      <div className="card">
        {providers.length === 0 && <div className="empty">등록된 프로바이더가 없습니다. 아래에서 추가하세요.</div>}
        {providers.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>사용</th><th>이름</th><th>종류</th><th>모델</th><th>API 키</th><th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="radio"
                      checked={p.id === activeId}
                      onChange={() => {
                        void window.api.setActiveProvider(p.id).then(refresh)
                      }}
                    />
                  </td>
                  <td>{p.label}</td>
                  <td className="dim">{p.type}</td>
                  <td className="dim">{p.model}</td>
                  <td className="dim">{p.hasKey ? '저장됨 (키체인)' : '-'}</td>
                  <td>
                    <button className="danger" onClick={() => void window.api.deleteProvider(p.id).then(refresh)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3>프로바이더 추가</h3>
      <div className="card grid-form">
        <span>종류</span>
        <select
          value={form.type}
          onChange={(e) => {
            const t = e.target.value as ProviderType
            setForm({ ...form, type: t, model: DEFAULT_MODEL[t] })
          }}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span>이름</span>
        <input
          placeholder="예: 회사 Claude 계정"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <span>모델</span>
        <input
          placeholder={form.type === 'openai-compatible' ? '모델 ID (예: OpenRouter는 vendor/model 형식)' : ''}
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        {needsBaseURL && (
          <>
            <span>Base URL</span>
            <input
              placeholder={
                form.type === 'ollama'
                  ? 'http://localhost:11434/v1 (기본값)'
                  : '예: https://openrouter.ai/api/v1 — /chat/completions는 붙이지 않음'
              }
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
            />
          </>
        )}
        {needsKey && (
          <>
            <span>API 키</span>
            <input
              type="password"
              placeholder="OS 키체인에 암호화 저장됩니다"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </>
        )}
        <span />
        <div className="row">
          <button className="primary" onClick={() => void save()}>추가</button>
          {saved && <span style={{ color: 'var(--ok)' }}>저장됨</span>}
        </div>
      </div>

      <h2>권한 규칙</h2>
      <div className="card">
        {rules.length === 0 && <div className="empty">저장된 규칙이 없습니다. 승인 다이얼로그에서 "항상 허용"을 선택하면 여기에 추가됩니다.</div>}
        {rules.length > 0 && (
          <table>
            <thead>
              <tr><th>도구</th><th>패턴</th><th>동작</th><th>범위</th><th></th></tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.toolName}</td>
                  <td className="dim">{r.pattern}</td>
                  <td>{r.action === 'allow' ? '허용' : '차단'}</td>
                  <td className="dim">{r.scope === 'always' ? '영구' : '세션'}</td>
                  <td>
                    <button className="danger" onClick={() => void window.api.deleteRule(r.id).then(refresh)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>감사 로그 (최근 100건)</h2>
      <div className="card">
        {audit.length === 0 && <div className="empty">아직 기록이 없습니다.</div>}
        {audit.length > 0 && (
          <table>
            <thead>
              <tr><th>시각</th><th>도구</th><th>내용</th><th>판정</th></tr>
            </thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={i}>
                  <td className="dim">{new Date(a.at).toLocaleString()}</td>
                  <td>{a.toolName}</td>
                  <td className="dim">{a.summary}</td>
                  <td className="dim">{a.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
