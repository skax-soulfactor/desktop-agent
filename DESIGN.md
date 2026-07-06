# Desktop Agent 설계 문서

> 관련 문서: [컴퓨터 제어(Computer Use) 설계](DESIGN-COMPUTER-USE.md) — 구현 보류, 효율 검증(CU-0) 후 결정

크로스 플랫폼(Windows / macOS / Linux) 데스크톱 에이전트 앱.
사용자가 채팅으로 요청하면 에이전트가 LLM과 로컬 도구(파일, 셸, 화면 등)를 조합해 처리하되,
**모든 데스크톱 자원 접근은 사용자 승인을 거친다.**

---

## 1. 기술 스택 추천

### 결론: TypeScript + Electron (1순위), Tauri 2는 대안

| 항목 | Electron + TypeScript (추천) | Tauri 2 (Rust + TS) | Qt / Flutter 등 |
|---|---|---|---|
| LLM SDK 생태계 | 최상 (Anthropic/OpenAI/Gemini 공식 TS SDK, Vercel AI SDK) | 프론트엔드에서만 TS 사용 가능 | 빈약 |
| 데스크톱 자원 접근 | Node.js로 즉시 가능 (node-pty, nut.js, clipboardy 등) | Rust로 직접 구현 필요 | 가능하나 생태계 작음 |
| 개발 속도 | 빠름 — 단일 언어(TS) | Rust 학습 비용 | 중간 |
| 배포 크기 / 메모리 | 크다 (~150MB / 수백 MB) | 작다 (~10MB) | 중간 |
| 검증 사례 | VS Code, Slack, Claude Desktop, ChatGPT Desktop | 신흥, 성장 중 | — |

**추천 이유:**
- 에이전트 앱의 핵심 복잡도는 UI가 아니라 **에이전트 루프 + 도구 실행 + 승인 흐름**이며, 이 로직을 LLM SDK와 같은 언어(TS)로 짜는 것이 가장 생산적이다.
- 셸 실행, 스크린샷, 클립보드, 키보드/마우스 자동화 등 데스크톱 기능이 npm 생태계에 이미 존재한다.
- Claude Desktop, ChatGPT Desktop 등 동일한 성격의 제품이 모두 Electron 기반 — 검증된 경로.

**Tauri를 선택할 조건:** 배포 크기·메모리 사용량이 중요하거나, Rust 역량이 이미 있고 보안 경계를 언어 수준에서 강하게 두고 싶은 경우. UI는 동일하게 React + TS를 쓰므로 프론트엔드 코드는 재사용 가능하다.

### 세부 스택

| 레이어 | 선택 |
|---|---|
| UI | React + TypeScript + Vite |
| 데스크톱 셸 | Electron (main / preload / renderer 분리) |
| LLM 추상화 | Vercel AI SDK (`ai` 패키지) — 프로바이더 어댑터 내장 |
| 로컬 저장 | SQLite (better-sqlite3): 대화 히스토리, 권한 정책, 감사 로그 |
| 비밀 저장 | OS 키체인 — Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux libsecret) |
| 패키징 | electron-builder → dmg / NSIS / AppImage·deb |

---

## 2. 전체 아키텍처

```
┌───────────────────────────────────────────────┐
│  Renderer (React) — 샌드박스, Node 접근 불가     │
│  채팅 UI · 스트리밍 표시 · 승인 다이얼로그 · 설정  │
└──────────────────┬────────────────────────────┘
                   │ IPC (preload에서 화이트리스트된 채널만)
┌──────────────────▼────────────────────────────┐
│  Main process                                  │
│  ┌──────────────┐   ┌───────────────────────┐  │
│  │ Agent Core   │──▶│ LLM Provider Layer    │  │
│  │ 대화 루프      │   │ Anthropic/OpenAI/     │  │
│  │ 도구 오케스트레이션│ │ Gemini/Ollama/호환API │  │
│  └──────┬───────┘   └───────────────────────┘  │
│         │ 모든 tool call                        │
│  ┌──────▼───────┐   ┌───────────────────────┐  │
│  │ Permission   │──▶│ Policy Store (SQLite) │  │
│  │ Gateway      │   │ Audit Log             │  │
│  └──────┬───────┘   └───────────────────────┘  │
│         │ 승인된 호출만                          │
│  ┌──────▼─────────────────────────────────┐    │
│  │ Tool Layer                              │    │
│  │ fs · shell · screenshot · clipboard ·   │    │
│  │ app launch · browser · MCP client       │    │
│  └────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────┐    │
│  │ Knowledge Base (SQLite + FTS5 + 벡터)    │    │
│  │ 요구사항·선호 기억 · 교훈(실수) 기록 ·      │    │
│  │ 매 턴 회상→프롬프트 주입 · 주기적 통합      │    │
│  └────────────────────────────────────────┘    │
└───────────────────────────────────────────────┘
```

핵심 원칙:
1. **Renderer는 신뢰하지 않는다** — `contextIsolation: true`, `nodeIntegration: false`. 도구 실행은 전부 main process에서.
2. **도구 호출은 단일 관문(Permission Gateway)을 통과한다** — 우회 경로 없음.
3. **API 키는 평문으로 디스크에 저장하지 않는다** — OS 키체인만 사용.

---

## 3. 에이전트 코어 — 메인/워커 분리와 대화 루프

### 3.0 메인/워커 에이전트 분리

사용자가 작업 완료를 기다리지 않도록 에이전트를 둘로 나눈다.

- **메인(대화) 에이전트**: 사용자와의 대화 전담. 직접 쓸 수 있는 도구는 빠른 읽기 전용(fs_read, fs_list)과
  작업 관리 도구(delegate_task / cancel_task / list_tasks)뿐이다. 무거운 작업은 위임 직후 턴을 끝내므로
  채팅은 항상 응답 가능하다.
- **워커 서브 에이전트**: `delegate_task`로 위임받은 자기완결적 지시를 백그라운드에서 수행하는 독립
  에이전트 루프. 전체 도구를 사용하며, 도구 호출은 동일한 Permission Gateway를 통과한다(승인
  다이얼로그는 대화 중에도 뜬다). 작업별 AbortController로 **개별 취소** 가능 — 사용자가 채팅으로
  "취소해줘"라고 하면 메인 에이전트가 cancel_task를 호출하고, UI의 작업 칩에서 직접 취소할 수도 있다.
- **병렬성**: 작업은 여러 개가 동시에 돌 수 있다. 진행 상황은 `task-update` 이벤트로 UI 작업 표시줄에
  실시간 반영되고, 종료(완료/실패/취소) 시 결과 카드가 대화에 남는다.
- **결과 전달**: 작업이 끝나면 세션 히스토리에 "[작업 알림]" 시스템 메시지가 append되어, 메인 에이전트가
  다음 턴에서 결과를 인지하고 이어서 제안할 수 있다. 동시 기록은 read-modify-write append로 보호한다.

### 3.0.1 예약/주기 작업 (스케줄러)

사용자가 대화로 특정 시각 실행("오후 3시에")이나 주기 실행("1시간마다", "매일 아침 9시")을 요청하면
메인 에이전트가 `schedule_task`로 등록한다. 스케줄 종류는 `once`(1회, ISO 시각) / `interval`(N분 간격,
최소 5분) / `daily`(매일 HH:MM). 메인 프로세스의 타이머(30초 틱)가 도래한 스케줄을 워커 작업
(`startTask`)으로 실행하므로, 승인·활동 로그·결과 카드 등 위임 작업의 모든 동작을 그대로 따른다.
1회 스케줄은 실행 후 비활성화되고, 주기는 다음 실행 시각을 재계산한다. 스케줄은 `schedules.json`에
영속되어 재시작 후에도 유지되며, **앱이 실행 중일 때만 동작한다** (OS 스케줄러 연동은 향후 과제).
관리는 "스케줄" 탭(활성 토글·삭제)과 대화(`list_schedules` / `cancel_schedule`) 양쪽에서 가능하다.

### 3.1 대화 루프

```
사용자 메시지
  → 지식베이스 회상 (관련 기억 top-k 검색 → 시스템 프롬프트에 주입)
  → LLM 호출 (시스템 프롬프트 + 기억 + 히스토리 + 도구 정의)
  → 응답 스트리밍
      ├─ 텍스트 → UI에 실시간 표시
      └─ tool call → 교훈 대조 (유사 실수 이력 확인)
                   → Permission Gateway
                       ├─ 정책상 자동 허용 → 실행
                       ├─ 승인 필요 → UI 다이얼로그 → 허용/거부
                       └─ 정책상 차단 → 거부 결과 반환
  → tool result를 히스토리에 추가하고 LLM 재호출
  → tool call이 더 없으면 턴 종료
  → (백그라운드) 기억 추출 패스 — 이번 턴에서 기억할 것 저장/갱신
```

- 최대 반복 횟수 제한(예: 25회)으로 무한 루프 방지.
- 사용자는 언제든 "중지" 버튼으로 턴을 취소할 수 있어야 함 (`AbortController` 전파).
- 히스토리가 컨텍스트 한도에 가까워지면 오래된 턴을 요약해 압축.

### 도구 인터페이스

```typescript
interface AgentTool {
  name: string;                    // "fs_read", "shell_exec" 등
  description: string;             // LLM에게 제공
  inputSchema: JSONSchema;
  riskLevel: 'read' | 'write' | 'execute';
  // 승인 다이얼로그에 보여줄 사람이 읽을 수 있는 요약
  describeCall(input: unknown): string;   // 예: "~/Documents/a.txt 읽기"
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

---

## 4. 승인(Permission) 시스템

### 위험도 분류

| 등급 | 예시 | 기본 정책 |
|---|---|---|
| `read` | 파일 읽기, 디렉토리 목록, 클립보드 읽기, 스크린샷 | 매번 승인 (설정에서 자동 허용 가능) |
| `write` | 파일 쓰기/삭제, 클립보드 쓰기 | 매번 승인 |
| `execute` | 셸 명령, 앱 실행, 키보드/마우스 제어, 네트워크 요청 | 매번 승인 + 상세 표시 |

### 승인 다이얼로그 선택지

- **이번만 허용** — 해당 호출 1회만.
- **이 세션에서 허용** — 앱 재시작 전까지 같은 패턴 자동 허용.
- **항상 허용** — 영구 규칙으로 저장. 반드시 **스코프**를 함께 저장:
  - 파일 도구: 경로 글롭 (`~/projects/**`)
  - 셸 도구: 명령 접두사 (`git *`, `npm run *`)
- **거부** — 거부 사유를 tool result로 LLM에 전달해 다른 방법을 시도하게 함.

### 정책 규칙 (SQLite 저장)

```typescript
interface PermissionRule {
  toolName: string;
  pattern: string;        // 글롭 또는 명령 접두사
  action: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
  createdAt: string;
}
```

매칭 순서: **deny 규칙 우선 → allow 규칙 → 없으면 사용자에게 질문.**

### 안전장치

- 위험 명령 하드 블랙리스트: `rm -rf /`, 디스크 포맷, 커널 설정 변경 등은 규칙과 무관하게 차단.
- 셸 도구는 타임아웃(기본 2분)과 출력 크기 제한.
- 모든 도구 호출(승인/거부 포함)을 감사 로그에 기록: 시각, 도구, 입력 요약, 결과, 승인 주체(사용자/정책).
- 설정 화면에서 "항상 허용" 규칙 목록을 보여주고 개별 삭제 가능하게.

### OS 수준 권한 (앱 자체가 받아야 하는 것)

| OS | 필요 권한 |
|---|---|
| macOS | 화면 기록(스크린샷), 손쉬운 사용(키/마우스 제어) — TCC 프롬프트 안내 UI 필요 |
| Windows | 기본적으로 불필요, UAC 상승이 필요한 명령은 도구에서 명시적 거부 |
| Linux | Wayland에서는 스크린샷/입력 제어에 portal(xdg-desktop-portal) 사용 |

---

## 5. LLM 프로바이더 추상화

사용자가 설정 화면에서 프로바이더 + 모델 + API 키를 등록하고 자유롭게 전환.

```typescript
interface LLMProviderConfig {
  id: string;
  type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible';
  baseURL?: string;        // openai-compatible, ollama용
  model: string;
  // apiKey는 이 객체에 저장하지 않음 — 키체인에서 id로 조회
}
```

**모델 등급 라우팅**: 등록한 프로바이더를 설정에서 경량/일반/고급 3등급에 배정한다.
작업 성격에 따라 자동 선택된다 — 대화(메인 에이전트)와 일반 위임 작업은 `standard`,
기억 추출 등 배경 작업은 `light`, 복잡한 분석·코드 작성은 메인 에이전트가 `delegate_task`의
tier 파라미터로 `advanced`를 지정한다(스케줄에도 tier 저장). 미배정 등급은 가까운 등급으로
폴백한다(예: light 미지정 → standard).

- **Vercel AI SDK** 사용을 권장: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ollama-ai-provider` 어댑터가 스트리밍·tool calling 형식 차이를 이미 흡수한다. 직접 어댑터를 짜는 것보다 유지비가 훨씬 낮다.
- `openai-compatible` 타입 하나로 LM Studio, vLLM, OpenRouter 등 대부분의 서드파티를 커버.
- 프로바이더별 tool calling 지원 여부를 체크하고, 미지원 모델 선택 시 UI에서 경고.
- API 키 검증: 등록 시 가벼운 테스트 호출로 유효성 확인.

---

## 6. 도구 계층 (MVP 목록)

| 도구 | 구현 (npm) | 위험도 |
|---|---|---|
| `fs_read` / `fs_list` | Node `fs` | read |
| `fs_write` / `fs_delete` | Node `fs` | write |
| `shell_exec` | `node-pty` (인터랙티브 출력 스트리밍) | execute |
| `screenshot` | `screenshot-desktop` | read |
| `clipboard_read` / `clipboard_write` | Electron `clipboard` | read / write |
| `app_open` | `open`/`start`/`xdg-open` 래퍼 | execute |
| `web_fetch` | `fetch` | execute |
| `input_control` (키/마우스) | `@nut-tree/nut-js` | execute |

**확장: MCP 클라이언트** — `@modelcontextprotocol/sdk`로 MCP 서버를 연결하면 사용자가 서드파티 도구(Slack, GitHub, DB 등)를 직접 추가할 수 있다. MCP 도구 호출도 동일하게 Permission Gateway를 통과시킨다.

---

## 7. 지식베이스 (Knowledge Base)

에이전트가 사용자와의 협업에서 얻은 지식을 **로컬에** 축적하고, 매 대화에서 활용하는 장기 기억 시스템.
목표는 두 가지다.

1. **사용자 이해** — 대화에서 요구사항·선호·진행 상황을 추출해 기록하고, 다음 대화에서 자동으로 회상해 의도 파악과 선제적 제안에 활용.
2. **자기 개선** — 실수·잘못된 판단을 교훈으로 기록하고, 유사한 행동을 하기 직전에 대조하여 같은 실수를 반복하지 않게 함.

### 7.1 기억 모델

```typescript
interface MemoryEntry {
  id: string;
  type: 'user' | 'requirement' | 'lesson' | 'reference';
  title: string;            // 한 줄 요약 (인덱스에 노출)
  content: string;          // 본문 (마크다운)
  tags: string[];
  sourceSessionId: string;  // 출처 대화 — 근거 추적용
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string;   // 통합/정리 시 사용 빈도 판단
  status: 'active' | 'archived';
}
```

| 타입 | 내용 | 예시 |
|---|---|---|
| `user` | 사용자의 역할, 전문성, 선호 | "TypeScript를 선호하고 설명은 한국어로" |
| `requirement` | 진행 중인 작업, 목표, 제약, 결정 사항 | "배포는 사내 서버만, AWS 금지" |
| `lesson` | 실수와 재발 방지 규칙 (아래 7.3) | "빌드 전 lint를 건너뛰어 배포 실패" |
| `reference` | 외부 자원 포인터 | "사내 위키 API 문서 URL" |

`lesson` 타입은 구조화된 본문을 강제한다:

```markdown
**상황:** 무엇을 하려 했나
**실수:** 무엇이 잘못됐나 (사용자 정정 발화 원문 포함)
**원인:** 왜 그렇게 판단했나
**재발 방지:** 다음에 같은 상황에서 어떻게 행동할 것인가 (검증 가능한 규칙 형태)
```

### 7.2 기록 (Write path) — 기억 추출 패스

- **시점**: 턴 종료 후 백그라운드에서 실행 (사용자 응답 지연 없음). 저비용 모델(Haiku 등)로 별도 LLM 호출.
- **입력**: 이번 턴의 대화 + 도구 실행 결과 + 기존 관련 기억 목록.
- **출력**: `create / update / delete / none` 결정. **중복 생성 금지** — 같은 주제의 기존 기억이 있으면 갱신한다. 사용자의 발언이 기존 기억과 모순되면 기존 것을 수정하거나 폐기.
- **저장하지 않는 것**: 대화 히스토리로 충분한 일회성 내용, 코드 자체에서 파악 가능한 사실, 민감 정보(비밀번호·토큰 — 추출 프롬프트에서 명시적 금지).

### 7.3 자기 개선 — 실패 신호와 교훈 루프

**실패 신호 감지** (기억 추출 패스가 다음 이벤트를 교훈 후보로 검토):

| 신호 | 수집 방법 |
|---|---|
| 사용자 정정 발화 ("아니야", "그게 아니라", "다시") | 추출 패스에서 LLM이 분류 |
| 승인 거부 | Permission Gateway 이벤트 — 특히 같은 패턴의 반복 거부 |
| 도구 실행 오류·타임아웃 후 우회 시도 | 감사 로그 연동 |
| 사용자가 결과물을 되돌리거나 재요청 | 세션 이벤트 |

**활용 (재발 방지):**

- **행동 직전 대조**: `execute`/`write` 등급 도구 호출 전에, 해당 도구·대상과 유사한 `lesson`을 검색해 시스템 프롬프트 컨텍스트에 포함. 예: `shell_exec("npm publish ...")` 직전에 "배포 관련 교훈" 회상.
- **턴 시작 시 주입**: 현재 요청과 관련된 교훈을 요구사항 기억과 함께 주입 (7.4).
- 같은 교훈이 반복 적중하면(재발) 추출 패스가 해당 교훈의 재발 방지 규칙을 더 구체적으로 강화한다.

### 7.4 회상 (Read path) — 프롬프트 주입

토큰 예산 이중 구조 (합계 상한 예: 2,000 토큰):

1. **상시 인덱스**: 모든 활성 기억의 `title` 한 줄 목록. 매 턴 시스템 프롬프트에 항상 포함 — 에이전트가 "무엇을 알고 있는지"를 항상 인지.
2. **관련 기억 전문 top-k**: 사용자 메시지를 쿼리로 하이브리드 검색(FTS5 키워드 + 벡터 유사도)해 상위 k개(예: 5개)의 `content` 전문을 주입. `lastRecalledAt` 갱신.

**검색 인프라**: SQLite FTS5(키워드) + `sqlite-vec`(벡터). 임베딩은 **로컬 모델**(transformers.js + bge-m3 등 다국어 소형 모델) 사용 — 프로바이더와 무관하게 동작하고(Ollama 오프라인 포함), 기억 내용이 임베딩 목적으로 외부에 전송되지 않는다.

### 7.5 선제적 제안

- 턴 시작 시 주입된 기억 중 현재 요청과 결합해 제안할 것이 있으면 응답에 자연스럽게 포함하도록 시스템 프롬프트에 지시. 예: "지난번에 배포 자동화를 원하셨는데, 이 스크립트를 그 파이프라인에 연결할까요?"
- 앱 유휴 시 주기적 **회고 패스**: 최근 세션들과 기억을 검토해 미완료 작업, 반복 패턴(자동화 후보), 모순된 요구사항을 찾아 UI의 제안 카드로 노출. 사용자가 클릭하면 새 대화로 시작.

### 7.6 유지 관리와 투명성

- **주기적 통합(consolidation)**: 유휴 시 LLM 패스로 중복 병합, 모순 해결, 오래되고 회상되지 않는 기억(`lastRecalledAt` 기준) 아카이브.
- **기억 관리 UI** (설정 화면): 전체 기억 목록 조회·수정·삭제, 출처 대화로 이동, 타입별 필터. 에이전트가 기억을 생성/갱신하면 채팅에 "기억함: …" 배지로 표시해 사용자가 즉시 정정할 수 있게 한다.
- **프라이버시**: 기억은 로컬 SQLite에만 저장. 단, 회상된 기억은 프롬프트에 포함되어 선택한 LLM 프로바이더로 전송됨을 설정 화면에 명시. 민감 태그가 붙은 기억은 주입 제외 옵션 제공.

---

## 8. 프로젝트 구조

```
desktop-agent/
├─ src/
│  ├─ main/                 # Electron main process
│  │  ├─ agent/             #   대화 루프, 컨텍스트 관리
│  │  ├─ llm/               #   프로바이더 설정/키 관리
│  │  ├─ permissions/       #   게이트웨이, 정책 저장소, 감사 로그
│  │  ├─ memory/            #   지식베이스: 추출·회상·교훈·통합
│  │  ├─ tools/             #   도구 구현 (fs, shell, screen, ...)
│  │  ├─ storage/           #   SQLite, safeStorage 래퍼
│  │  └─ ipc.ts             #   IPC 핸들러 등록 (단일 지점)
│  ├─ preload/              # contextBridge — 채널 화이트리스트
│  ├─ renderer/             # React 앱
│  │  ├─ chat/              #   메시지 목록, 입력, 스트리밍 표시
│  │  ├─ approval/          #   승인 다이얼로그
│  │  ├─ memory/            #   기억 관리 UI, 제안 카드
│  │  └─ settings/          #   프로바이더, 권한 규칙, 감사 로그 뷰
│  └─ shared/               # IPC 메시지 타입, 도구 스키마 (양쪽 공유)
├─ electron-builder.yml
└─ package.json
```

---

## 9. 크로스 플랫폼 주의점

- **셸**: Windows는 PowerShell, macOS/Linux는 사용자 기본 셸(`$SHELL`). 도구 정의에 현재 OS·셸을 명시해 LLM이 올바른 문법을 쓰게 한다.
- **경로**: 항상 `path.join`/`os.homedir()` 사용, `~` 확장은 도구 레이어에서 처리.
- **자동 업데이트**: electron-updater (macOS/Windows), Linux는 AppImage 업데이트 또는 배포판 패키지.
- **코드 서명**: macOS notarization, Windows 코드 서명 인증서 — 없으면 실행 시 경고가 떠서 배포 품질에 직결.

---

## 10. 구현 로드맵

| 단계 | 범위 |
|---|---|
| **M1** | Electron + React 뼈대, 채팅 UI, Anthropic 단일 프로바이더, 스트리밍 |
| **M2** | 도구 3종(fs_read/fs_write/shell_exec) + 승인 다이얼로그(이번만/거부) |
| **M3** | 정책 저장소("항상 허용" 스코프 규칙), 감사 로그, 세션 히스토리 |
| **M4** | 멀티 프로바이더(OpenAI/Gemini/Ollama/호환 API), 키체인 저장, 설정 UI |
| **M5** | 지식베이스 1차: 기억 추출·회상(FTS5 키워드), 기억 관리 UI, "기억함" 배지 |
| **M6** | 지식베이스 2차: 로컬 임베딩 벡터 검색, 교훈 루프(실패 신호 감지·행동 직전 대조), 통합 패스 |
| **M7** | 스크린샷·클립보드·앱 실행 도구, MCP 클라이언트, 선제적 제안(회고 패스) |
| **M8** | 패키징·코드 서명·자동 업데이트, OS별 권한 온보딩 |
