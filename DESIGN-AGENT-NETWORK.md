# 에이전트 네트워크 (Agent-to-Agent) 설계

사용자별로 전문화된 에이전트들(코딩/PM/구매/인사 등)이 **에이전트 카드**를 교환하고
서로 호출해 지식을 활용하는 기능의 설계. 본체 설계는 [DESIGN.md](DESIGN.md) 참조.

---

## 1. 진행 방향 검토

**타당하다.** 이 구상은 업계에서 표준화가 진행 중인 **A2A(Agent2Agent) 프로토콜** 패턴과
정확히 일치한다 — 에이전트 카드(`/.well-known/agent-card.json`)로 능력을 공개하고,
JSON-RPC로 메시지/작업을 주고받는 구조. 따라서 **독자 프로토콜을 만들지 말고 A2A 호환으로
구현**할 것을 권장한다. 이유:

- 카드 스키마·전송·스트리밍·작업 상태 관리가 이미 정의되어 있어 설계 비용이 준다.
- 우리 앱끼리만이 아니라 A2A를 지원하는 외부 에이전트 생태계와도 연결된다.
- 중계서버 확장(§8)도 A2A 생태계의 방향과 일치한다.

핵심 설계 원칙 세 가지 (검토 과정에서 확정해야 할 결정 사항):

1. **지식은 이동하지 않는다.** 지식베이스를 상대에게 전송·복제하지 않는다. 카드만 공개하고,
   상대의 질문에 자기 지식으로 "답변"만 제공한다 (데이터 공유가 아닌 능력 공유).
   개인·회사 정보가 담긴 기억의 유출 리스크를 구조적으로 차단한다.
2. **양방향 승인 페어링.** IP:Port만 알면 아무나 연결되는 구조는 위험하다. 등록 요청 시
   상대 사용자의 명시적 승인을 거쳐 페어링 토큰을 교환한다.
3. **수신 요청도 승인 게이트웨이를 통과한다.** 원격 요청은 위험도 높은 입력이므로
   피어별 정책(자동 허용/승인 요청/차단)으로 통제하고, 처리하는 워커의 도구를 제한한다.

**주의할 리스크**: 응답 비용은 응답자가 부담한다(자기 LLM 키 사용) → 피어별 사용량 상한 필요.
에이전트 간 순환 호출(A→B→A) → 홉 제한 필요. 사내 방화벽/NAT → v1은 같은 네트워크 전제,
교차 네트워크는 중계서버(v2)로 해결.

---

## 2. 에이전트 카드

### 2.1 스키마 (A2A AgentCard 호환 + 확장)

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "준혁의 에이전트",
  "description": "J2EE 레거시 현대화와 TypeScript 데스크톱 앱 개발을 전문으로 하는 에이전트",
  "url": "http://192.168.0.10:7810/a2a",          // v2: relay://relay.example.com/agents/{id}
  "provider": { "organization": "SKAX" },
  "version": "2026-07-07.1",
  "capabilities": { "streaming": true },
  "skills": [                                       // A2A 표준 필드 — 지식베이스에서 자동 도출
    {
      "id": "java-legacy-modernization",
      "name": "Java/J2EE 레거시 분석·현대화",
      "description": "J2EE 프로젝트 빌드 오류 진단, 소스 분석, 마이그레이션 계획",
      "tags": ["java", "j2ee", "빌드", "리팩토링"]
    },
    { "id": "obsidian-research", "name": "자료 조사·옵시디안 정리", "...": "..." }
  ],
  "x-desktopAgent": {                               // 앱 확장 필드
    "specialtySummary": "코딩 전문 (Java 레거시, TypeScript/Electron)",
    "acceptedTaskTypes": ["question", "task"],      // 질의응답만 / 작업 위임까지
    "cardGeneratedAt": "2026-07-07T09:00:00+09:00",
    "userEditedFields": ["description"]             // 자동 갱신에서 보호되는 필드
  }
}
```

### 2.2 자동 생성·갱신 (지식베이스 기반)

- **생성 패스**: 지식베이스 전체 인덱스(제목+타입+태그)와 최근 세션 주제를 입력으로
  경량 등급 LLM이 skills·specialtySummary를 도출. `공유 제외` 태그가 붙은 기억은 입력에서 제외.
- **주기**: 기존 스케줄러 재사용 — 매일 1회 + 기억 20건 이상 변경 시. 변경이 있을 때만
  version을 올리고, 변경 요약을 채팅에 notice 카드로 알린다 ("에이전트 카드 갱신: 스킬 2개 추가").
- **사용자 확인·변경**: "에이전트 카드" 설정 화면에서 전체 필드 조회·편집.
  사용자가 수정한 필드는 `userEditedFields`에 기록되어 자동 갱신이 덮어쓰지 않는다.
  자동 생성 자체를 끄는 옵션 제공.

---

## 3. 전송 계층 — 중계서버 확장을 위한 추상화

```typescript
interface AgentTransport {
  // 아웃바운드
  fetchCard(address: string): Promise<AgentCard>
  send(peer: Peer, req: A2ARequest, onEvent?: (e: A2AStreamEvent) => void): Promise<A2AResponse>
  // 인바운드 (서버 기동)
  listen(handlers: InboundHandlers): Promise<void>
  stop(): Promise<void>
}
```

| 구현 | v | 주소 형식 | 특징 |
|---|---|---|---|
| `DirectHttpTransport` | v1 | `http://ip:port` | Node `http` 서버를 main 프로세스에 내장. 같은 네트워크 전제 |
| `RelayTransport` | v2 | `relay://host/agentId` | 중계서버와 WebSocket 상시 연결. NAT 통과, 오프라인 큐, 카드 디렉토리(검색) |

피어 레코드에 주소만 저장하므로 **상위 로직(라우팅·승인·워커)은 전송 방식과 무관**하다.
중계서버 자체는 별도 프로젝트(메시지 라우팅 + 카드 디렉토리 + 인증)로 이 문서 범위 밖.

v1 보안 주의: 평문 HTTP + LAN 전제. 사외 연결은 VPN(Tailscale 등) 위에서 사용 권장,
TLS는 중계서버(v2)에서 해결.

---

## 4. 페어링 (최초 연결)

```
[A 사용자] "에이전트 네트워크" 탭 → 주소 입력 (192.168.0.20:7810)
  1. A → B: GET /.well-known/agent-card.json        (카드 미리보기 — 인증 불필요, 카드만 공개)
  2. A 사용자: 카드 확인 후 "페어링 요청"
  3. A → B: POST /pair { requesterCard, nonce }
  4. B 화면에 승인 다이얼로그: "준혁의 에이전트(코딩 전문)가 연결을 요청합니다"
     → B 사용자 승인 시: B → A 응답 { accepted, pairToken(B가 발급), responderCard }
     → A도 자기 토큰을 발급해 전달 (상호 토큰)
  5. 양쪽 peers.json에 등록: { id, name, address, card, myToken, theirToken, policy, status }
```

- 이후 모든 요청은 `Authorization: Bearer {상대가 발급한 토큰}`. 토큰은 키체인이 아닌
  peers.json에 저장하되 카드·주소와 분리 파일(peer-tokens.json)로.
- 페어링 해제는 어느 쪽에서든 가능(토큰 폐기 통지). 카드 변경 시 상대에게 버전 통지,
  다음 요청 때 재조회.

---

## 5. 프로토콜 (A2A JSON-RPC 준용)

엔드포인트: `POST /a2a` (JSON-RPC 2.0), `GET /.well-known/agent-card.json`

| 메서드 | 용도 |
|---|---|
| `message/send` | 질의/작업 요청. parts에 텍스트(+파일). 응답: 즉답 메시지 또는 task 핸들 |
| `message/stream` | 동일하되 SSE 스트리밍 (긴 작업의 진행 상황) |
| `tasks/get` | 위임 작업 상태 조회 |
| `tasks/cancel` | 위임 작업 취소 |

확장 메타데이터(요청 metadata 필드): `callChain: [agentId...]` (홉 제한용, 최대 깊이 2),
`taskType: "question" | "task"`, `deadline`.

---

## 6. 수신 요청 처리 (응답측)

```
요청 수신 → 토큰 검증 → 피어 정책 평가
  ├─ question (질의응답): 기본 자동 허용 (정책으로 변경 가능)
  │    → 원격질의 전용 워커 실행:
  │       - 도구 없음. 지식베이스 회상(공유 제외 태그 제외) + 질문만으로 답변 생성
  │       - 경량/일반 등급 사용, 답변을 스트리밍 반환
  └─ task (작업 위임): 기본 승인 요청 (다이얼로그: 요청자·내용 표시)
       → 승인 시 기존 startTask로 워커 실행 (파일·셸 도구는 기존 승인 게이트웨이 그대로)
       → task 핸들 반환, 진행/완료를 스트리밍 통지
```

- **피어별 정책** (peers.json의 policy): `{ question: 'auto'|'ask'|'deny', task: 'ask'|'deny',
  dailyLimit: number }`. 기본값 question=auto, task=ask, dailyLimit=50.
- **지식 보호**: 회상 단계에서 `공유 제외` 태그 기억을 필터링. 응답 워커의 시스템 프롬프트에
  "사용자 개인정보·자격증명·내부 경로는 답변에 포함하지 마라" 명시.
- 수신 활동은 채팅과 별개의 "수신 요청" 목록(네트워크 탭)에 기록 + 감사 로그.

## 7. 발신 (요청측) — 메인 에이전트 통합

메인 에이전트에 도구 3종 추가 (기존 taskTools 패턴):

```typescript
list_peers     {}                                   // 등록 피어와 카드 요약(스킬·전문분야) 반환
ask_peer       { peerId, question }                 // 질의응답 — 응답을 대화에 바로 활용
delegate_to_peer { peerId, title, instruction }     // 작업 위임 — 원격 task 핸들을 로컬 작업 칩으로 표시
```

- **라우팅**: 시스템 프롬프트에 피어 카드 요약을 상시 주입(기억 인덱스와 동일 패턴, 토큰 예산 내).
  "요청이 내 전문 밖이고 적합한 피어가 있으면 ask_peer를 제안/사용하라. 위임 전 어느
  에이전트에 보낼지 사용자에게 알려라."
- 원격 위임 작업은 로컬 작업 칩과 동일 UX (진행 스트림 → task-update 이벤트로 변환, 취소 지원).
- 발신도 감사 로그 기록 (무엇을 어느 피어에 보냈는지).

---

## 8. UI — "네트워크" 탭

- **내 에이전트 카드**: 미리보기 + 편집 + 자동 갱신 토글 + "지금 갱신".
- **피어 목록**: 카드 요약, 상태(온라인/오프라인 — 주기 핑), 정책 편집, 사용량, 페어링 해제.
- **피어 추가**: 주소 입력 → 카드 미리보기 → 페어링 요청.
- **수신 요청 로그**: 최근 수신 질의/작업, 처리 결과.
- 서버 설정: 수신 포트(기본 7810), 수신 켜기/끄기(끄면 발신 전용).

---

## 9. 구현 로드맵

| 단계 | 범위 |
|---|---|
| **N1** | 에이전트 카드: 자동 생성 패스(스케줄러 재사용) + 카드 편집 UI + 공유 제외 태그 |
| **N2** | DirectHttpTransport 서버 + 페어링(양방향 승인·토큰) + 네트워크 탭 |
| **N3** | 수신 question 처리(도구 없는 응답 워커) + 발신 ask_peer/list_peers + 라우팅 프롬프트 |
| **N4** | task 위임(양방향, 스트리밍, 취소) + 피어 정책·사용량 상한 + 감사 로그 |
| **N5** | RelayTransport + 중계서버(별도 프로젝트: 라우팅·디렉토리·TLS·오프라인 큐) |

N1~N3까지가 "B의 PM 에이전트에게 일정 산정 기준을 물어봐줘"가 동작하는 최소 단위다.

## 10. 구현 현황 (2026-07-07)

N1~N4 구현 완료, N5는 RelayTransport 인터페이스 스텁까지.

| 모듈 | 파일 |
|---|---|
| 저장소 (설정·카드·피어·토큰·수신로그) | `src/main/network/store.ts` |
| 카드 자동 생성 (지식베이스 기반, 편집 필드 보존) | `src/main/network/card.ts` |
| 프로토콜·전송 인터페이스 | `src/main/network/protocol.ts` |
| DirectHttpTransport (내장 http 서버) | `src/main/network/directTransport.ts` |
| RelayTransport (v2 스텁) | `src/main/network/relayTransport.ts` |
| 매니저 (페어링·인바운드 라우팅·아웃바운드·승인) | `src/main/network/manager.ts` |
| 원격 질의 응답 워커 (도구 없음, 공유제외 필터) | `src/main/network/responder.ts` |
| 메인 에이전트 피어 도구 | `src/main/network/peerTools.ts` |
| UI (네트워크 탭, 승인 다이얼로그) | `src/renderer/src/network/` |

미구현/후속: 카드 자동 갱신 스케줄 연동(현재 수동 "지금 갱신"), 스트리밍 응답(현재 요청/응답),
피어 온라인 핑, RelayTransport 실동작.
