import { useEffect, useState } from 'react'
import UpdateSection from './UpdateSection'
import type {
  AuditRecord,
  McpServerConfig,
  McpTransportKind,
  ModelTier,
  PermissionRule,
  ProviderConfig,
  ProviderType,
  SecretMeta,
  TierAssignment
} from '@shared/types'

const TIER_INFO: { tier: ModelTier; label: string; desc: string }[] = [
  { tier: 'light', label: '경량', desc: '기억 추출, 단순 수집·정리 작업' },
  { tier: 'standard', label: '일반', desc: '대화(메인 에이전트), 일반 작업 — 기본값' },
  { tier: 'advanced', label: '고급', desc: '복잡한 분석, 코드 작성, 중요 문서' }
]

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

const emptyForm = (): ProviderConfig & { apiKey: string; contextText: string } => ({
  id: crypto.randomUUID(),
  type: 'anthropic',
  label: '',
  model: DEFAULT_MODEL.anthropic,
  baseURL: '',
  apiKey: '',
  contextText: ''
})

const emptyMcpForm = (): {
  name: string
  transport: McpTransportKind
  command: string
  url: string
  headersJson: string
  envJson: string
} => ({ name: '', transport: 'stdio', command: '', url: '', headersJson: '', envJson: '' })

/** 로컬 서버에서 도는 모델인가 — 컨텍스트 기본값 표시에만 쓴다 (판정 본체는 main/llm/profile.ts) */
function isLocalEndpoint(p: ProviderConfig): boolean {
  if (p.type === 'ollama') return true
  return p.type === 'openai-compatible' && /\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(p.baseURL ?? '')
}

/** JSON 오브젝트 입력(선택)을 파싱. 비어 있으면 undefined, 잘못됐으면 오류 던짐 */
function parseRecord(label: string, json: string): Record<string, string> | undefined {
  const t = json.trim()
  if (!t) return undefined
  const parsed = JSON.parse(t) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}은 {"키":"값"} 형태여야 합니다.`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
  return out
}

export default function SettingsView(): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [tiers, setTiers] = useState<TierAssignment>({ light: null, standard: null, advanced: null })
  const [form, setForm] = useState(emptyForm())
  const [rules, setRules] = useState<PermissionRule[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [saved, setSaved] = useState(false)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [secForm, setSecForm] = useState({ name: '', value: '' })
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [mcpForm, setMcpForm] = useState(emptyMcpForm())
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [elevation, setElevation] = useState(false)

  const refresh = async (): Promise<void> => {
    const p = await window.api.listProviders()
    setProviders(p.providers)
    setTiers(p.tiers)
    setRules(await window.api.listRules())
    setAudit(await window.api.listAudit())
    setSecrets(await window.api.listSecrets())
    setMcpServers(await window.api.mcpList())
    setElevation(await window.api.getElevationEnabled())
  }

  const addSecret = async (): Promise<void> => {
    if (!secForm.name.trim() || !secForm.value.trim()) return
    await window.api.setSecret(secForm.name.trim(), secForm.value)
    setSecForm({ name: '', value: '' })
    await refresh()
  }

  const addMcp = async (): Promise<void> => {
    setMcpError(null)
    if (!mcpForm.name.trim()) return
    try {
      const cfg: McpServerConfig = {
        id: crypto.randomUUID(),
        name: mcpForm.name.trim(),
        transport: mcpForm.transport,
        enabled: true,
        createdAt: new Date().toISOString()
      }
      if (mcpForm.transport === 'stdio') {
        const parts = mcpForm.command.trim().split(/\s+/)
        if (parts.length === 0 || !parts[0]) throw new Error('실행 명령을 입력하세요.')
        cfg.command = parts[0]
        cfg.args = parts.slice(1)
        cfg.env = parseRecord('환경 변수', mcpForm.envJson)
      } else {
        if (!mcpForm.url.trim()) throw new Error('서버 URL을 입력하세요.')
        cfg.url = mcpForm.url.trim()
        cfg.headers = parseRecord('헤더', mcpForm.headersJson)
      }
      await window.api.mcpSave(cfg)
      setMcpForm(emptyMcpForm())
      await refresh()
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e))
    }
  }

  const runTest = async (id: string): Promise<void> => {
    setTesting(id)
    try {
      await window.api.mcpTest(id)
    } finally {
      setTesting(null)
      await refresh()
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const needsBaseURL = form.type === 'ollama' || form.type === 'openai-compatible'
  const needsKey = form.type !== 'ollama'

  /**
   * 기존 프로바이더를 아래 폼으로 불러온다. 같은 id로 저장하면 갱신되므로
   * 컨텍스트 값 하나를 바꾸려고 지웠다 다시 만들 필요가 없다.
   * API 키는 비워 둔 채로 저장하면 키체인에 있는 기존 값이 그대로 유지된다.
   */
  const editProvider = (p: ProviderConfig): void => {
    setForm({
      id: p.id,
      type: p.type,
      label: p.label,
      model: p.model,
      baseURL: p.baseURL ?? '',
      apiKey: '',
      contextText: p.contextTokens ? String(p.contextTokens) : ''
    })
  }

  const editingExisting = providers.some((p) => p.id === form.id)

  const save = async (): Promise<void> => {
    if (!form.label || !form.model) return
    const contextTokens = Number.parseInt(form.contextText, 10)
    await window.api.saveProvider(
      {
        id: form.id,
        type: form.type,
        label: form.label,
        model: form.model,
        baseURL: form.baseURL || undefined,
        contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : undefined
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
      <UpdateSection />

      <h2>LLM 프로바이더</h2>
      <div className="card">
        {providers.length === 0 && <div className="empty">등록된 프로바이더가 없습니다. 아래에서 추가하세요.</div>}
        {providers.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>이름</th><th>종류</th><th>모델</th><th>컨텍스트</th><th>API 키</th><th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td className="dim">{p.type}</td>
                  <td className="dim">{p.model}</td>
                  <td className="dim">
                    {p.contextTokens
                      ? `${p.contextTokens.toLocaleString()} 토큰`
                      : isLocalEndpoint(p)
                        ? '4,096 (기본값)'
                        : '-'}
                  </td>
                  <td className="dim">{p.hasKey ? '저장됨 (키체인)' : '-'}</td>
                  <td>
                    <div className="row">
                      <button onClick={() => editProvider(p)}>수정</button>
                      <button className="danger" onClick={() => void window.api.deleteProvider(p.id).then(refresh)}>
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

      <h3>모델 역할 배정</h3>
      <div className="card">
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>
          작업 성격에 따라 에이전트가 등급을 자동 선택합니다. 미지정 등급은 가까운 등급으로 대체됩니다.
        </div>
        <table>
          <tbody>
            {TIER_INFO.map(({ tier, label, desc }) => (
              <tr key={tier}>
                <td style={{ width: 60 }}>{label}</td>
                <td className="dim">{desc}</td>
                <td style={{ width: 220 }}>
                  <select
                    value={tiers[tier] ?? ''}
                    onChange={(e) => {
                      void window.api.setTier(tier, e.target.value || null).then(refresh)
                    }}
                  >
                    <option value="">(미지정)</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} — {p.model}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>{editingExisting ? '프로바이더 수정' : '프로바이더 추가'}</h3>
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
            <span>컨텍스트</span>
            <div>
              <input
                style={{ width: '100%', boxSizing: 'border-box' }}
                placeholder="토큰 수 — 비워두면 4096 (Ollama 서버 기본값)"
                value={form.contextText}
                onChange={(e) => setForm({ ...form, contextText: e.target.value })}
              />
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 6 }}>
                모델이 지원하는 최대 길이가 아니라 <b>서버가 실제로 여는 창</b>을 적으세요. Ollama는
                모델과 무관하게 기본 4096으로 뜹니다 — <code>OLLAMA_CONTEXT_LENGTH</code> 환경 변수로
                올린 뒤 그 값을 여기에 적으면 에이전트가 프롬프트·기억·도구 결과를 그만큼 넉넉히 씁니다.
                실제보다 크게 적으면 프롬프트가 오류 없이 잘려 엉뚱한 답이 나옵니다.
              </div>
            </div>
          </>
        )}
        {needsKey && (
          <>
            <span>API 키</span>
            <input
              type="password"
              placeholder={
                editingExisting
                  ? '비워두면 기존 키를 그대로 사용합니다'
                  : 'OS 키체인에 암호화 저장됩니다'
              }
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </>
        )}
        <span />
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            {editingExisting ? '저장' : '추가'}
          </button>
          {editingExisting && <button onClick={() => setForm(emptyForm())}>취소</button>}
          {saved && <span style={{ color: 'var(--ok)' }}>저장됨</span>}
        </div>
      </div>

      <h2>연동 시크릿</h2>
      <div className="card">
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>
          외부 서비스 토큰·키를 OS 키체인에 암호화 저장합니다. 에이전트는 이름만 볼 수 있고, 도구 실행 시{' '}
          <code>{'{{secret:이름}}'}</code> 플레이스홀더가 실제 값으로 치환됩니다.
        </div>
        {secrets.length > 0 && (
          <table>
            <thead>
              <tr><th>이름</th><th>등록일</th><th></th></tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="dim">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td>
                    <button className="danger" onClick={() => void window.api.deleteSecret(s.name).then(refresh)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <input
            placeholder="이름 (예: notion)"
            value={secForm.name}
            onChange={(e) => setSecForm({ ...secForm, name: e.target.value })}
          />
          <input
            type="password"
            placeholder="토큰/키 값"
            style={{ flex: 1 }}
            value={secForm.value}
            onChange={(e) => setSecForm({ ...secForm, value: e.target.value })}
          />
          <button className="primary" onClick={() => void addSecret()}>추가</button>
        </div>
      </div>

      <h2>MCP 서버</h2>
      <div className="card">
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>
          등록된 MCP 서버의 도구는 백그라운드 워커가 사용합니다 (호출 시마다 승인 게이트 통과). 에이전트가 대화 중
          직접 등록할 수도 있습니다.
        </div>
        {mcpServers.length > 0 && (
          <table>
            <thead>
              <tr><th>이름</th><th>연결</th><th>상태</th><th>사용</th><th></th></tr>
            </thead>
            <tbody>
              {mcpServers.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="dim">
                    {s.transport === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}` : s.url}
                  </td>
                  <td className="dim">
                    {s.lastStatus
                      ? s.lastStatus.ok
                        ? `정상 (도구 ${s.lastStatus.tools?.length ?? 0}개)`
                        : `오류: ${s.lastStatus.error?.slice(0, 60)}`
                      : '-'}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => void window.api.mcpSave({ ...s, enabled: e.target.checked }).then(refresh)}
                    />
                  </td>
                  <td>
                    <div className="row">
                      <button disabled={testing === s.id} onClick={() => void runTest(s.id)}>
                        {testing === s.id ? '테스트 중…' : '테스트'}
                      </button>
                      <button className="danger" onClick={() => void window.api.mcpDelete(s.id).then(refresh)}>
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid-form" style={{ marginTop: 10 }}>
          <span>이름</span>
          <input
            placeholder="예: notion"
            value={mcpForm.name}
            onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
          />
          <span>방식</span>
          <select
            value={mcpForm.transport}
            onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value as McpTransportKind })}
          >
            <option value="stdio">로컬 명령 (stdio)</option>
            <option value="http">원격 서버 (http)</option>
          </select>
          {mcpForm.transport === 'stdio' ? (
            <>
              <span>명령</span>
              <input
                placeholder="예: npx -y @notionhq/notion-mcp-server"
                value={mcpForm.command}
                onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
              />
              <span>환경 변수</span>
              <input
                placeholder={'JSON (선택) — 예: {"NOTION_TOKEN": "{{secret:notion}}"}'}
                value={mcpForm.envJson}
                onChange={(e) => setMcpForm({ ...mcpForm, envJson: e.target.value })}
              />
            </>
          ) : (
            <>
              <span>URL</span>
              <input
                placeholder="예: https://mcp.example.com/mcp"
                value={mcpForm.url}
                onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })}
              />
              <span>헤더</span>
              <input
                placeholder={'JSON (선택) — 예: {"Authorization": "Bearer {{secret:notion}}"}'}
                value={mcpForm.headersJson}
                onChange={(e) => setMcpForm({ ...mcpForm, headersJson: e.target.value })}
              />
            </>
          )}
          <span />
          <div className="row">
            <button className="primary" onClick={() => void addMcp()}>추가</button>
            {mcpError && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{mcpError}</span>}
          </div>
        </div>
      </div>

      <h2>권한 상승 (관리자 권한)</h2>
      <div className="card">
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={elevation}
            onChange={(e) => {
              const next = e.target.checked
              setElevation(next)
              void window.api.setElevationEnabled(next).then(refresh)
            }}
          />
          <div>
            에이전트가 관리자 권한 실행을 <strong>요청</strong>할 수 있게 허용
            <div className="dim" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.6 }}>
              켜도 에이전트가 권한을 갖는 것은 아닙니다. 매번 승인 창이 뜨고, 허용하면 그때
              운영체제의 인증 창이 떠서 <strong>사용자가 직접 비밀번호를 입력</strong>합니다.
              비밀번호는 OS만 받으며 에이전트·이 앱·대화 기록·감사 로그 어디에도 남지 않습니다.
              승인은 1회용이라 "항상 허용"이 없고, 예약 실행이나 다른 에이전트의 위임처럼
              사람이 없는 작업에서는 아예 차단됩니다. 꺼 두면 도구 자체가 노출되지 않습니다.
            </div>
          </div>
        </label>
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
              <tr><th>시각</th><th>도구</th><th>내용</th><th>목적</th><th>판정</th></tr>
            </thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={i}>
                  <td className="dim">{new Date(a.at).toLocaleString()}</td>
                  <td>
                    {a.toolName}
                    {a.elevated && <span className="risk elevate" style={{ marginLeft: 6 }}>root</span>}
                  </td>
                  <td className="dim">{a.summary}</td>
                  <td className="dim">{a.purpose ?? '—'}</td>
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
