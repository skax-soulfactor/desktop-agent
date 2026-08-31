# Desktop Agent

Windows / macOS / Linux에서 동작하는 데스크톱 에이전트 앱.
채팅으로 요청하면 에이전트가 LLM과 로컬 도구(파일, 셸)를 조합해 처리하며,
모든 데스크톱 자원 접근은 승인 다이얼로그를 거친다. 설계 문서: [DESIGN.md](DESIGN.md)

## 실행

```bash
npm install
npm run dev        # 개발 모드 (HMR)
npm run build      # 프로덕션 번들 (out/)
npx electron .     # 빌드된 번들 실행
```

## 배포

설치 파일 빌드는 electron-builder, 배포는 GitHub Releases, 자동 업데이트는 electron-updater를 쓴다.
`npm version patch && git push --follow-tags` 두 줄이면 CI가 3개 OS 설치 파일을 빌드해 Release에
올리고, 기존 사용자는 자동 업데이트를 받는다. 상세: [docs/RELEASE.md](docs/RELEASE.md)

## 첫 사용

1. 상단 **설정** 탭에서 LLM 프로바이더 등록 (Anthropic / OpenAI / Google / Ollama / OpenAI 호환).
   API 키는 OS 키체인 기반(safeStorage)으로 암호화 저장된다.
2. **대화** 탭에서 요청 입력. 에이전트가 도구를 사용하려 하면 승인 다이얼로그가 뜬다 —
   거부 / 이번만 허용 / 세션 허용 / 항상 허용(패턴 스코프 지정).
   사이드바는 경계를 끌어 폭을 바꾸고(더블클릭하면 기본값), 상단 `‹`로 접고, `⇄`로 좌우 위치를 바꾼다.
   ⌘/Ctrl+B로도 접었다 펼 수 있다. 세 설정 모두 localStorage에 남아 앱을 다시 열어도 유지된다.
3. **지식베이스** 탭에서 에이전트가 축적한 기억(사용자·요구사항·교훈·참조)을 관리.
   검색·정렬·태그 필터, 전문 편집, 보관/복구, 다중 선택 일괄 처리, 직접 추가, 내보내기/가져오기를 제공한다.
   상단의 **점검 필요** 배지는 중복·노후·형식 불일치·출처 유실 기억을 자동으로 찾아 준다.
   **매 턴 주입량**을 누르면 프롬프트에 실제로 들어가는 지식베이스 블록을 그대로 볼 수 있다.
   설계 근거: [docs/DESIGN-KNOWLEDGE-BASE.md](docs/DESIGN-KNOWLEDGE-BASE.md)

## 관리자 권한이 필요할 때

에이전트는 root 권한도, 그것을 얻는 수단(비밀번호)도 갖지 않는다. `shell_exec`에서 `sudo`·`su`·
`pkexec`·`runas`는 권한 게이트웨이가 차단하고, 관리자 권한이 정말 필요한 작업은 별도 도구
`shell_exec_elevated`로만 갈 수 있다. 그 경로는 이렇게 동작한다.

1. **설정 > 권한 상승**에서 사용자가 직접 켜야 한다 (기본 꺼짐 — 꺼져 있으면 도구가 아예 노출되지 않는다).
2. 요청이 올 때마다 승인 창이 뜬다. root로 넘어갈 인자가 한 줄에 하나씩 그대로 표시된다.
3. 허용하면 그때 **운영체제의 인증 창**(polkit / UAC / macOS 인증)이 떠서 사용자가 비밀번호를
   직접 입력한다. 비밀번호는 OS만 받으며 에이전트·앱·대화 기록·감사 로그 어디에도 남지 않는다.
4. 승인은 **1회용**이다. "이 세션에서 허용"·"항상 허용"이 없고 규칙으로 저장되지 않는다.
5. 예약 실행이나 다른 에이전트의 위임처럼 **사람이 지켜보지 않는 작업**, 그리고 앱 창이 보이지
   않는 상태에서는 요청 자체가 거부된다.

설계 근거와 채택하지 않은 방안(비밀번호 저장 등): [docs/DESIGN-PRIVILEGE-ELEVATION.md](docs/DESIGN-PRIVILEGE-ELEVATION.md)

## 로컬 LLM (Ollama 등)으로 쓸 때

로컬 모델에서 "없는 도구 이름을 부른다", "도구를 쓰지 않고 되묻는다", "기억 추출 실패"가 나오면
대부분 원인은 모델 성능이 아니라 **컨텍스트 창**이다. Ollama는 모델이 지원하는 최대 길이와 무관하게
기본 4096토큰으로 모델을 올리는데(`/api/ps`의 `context_length`로 확인), 에이전트의 시스템 프롬프트와
도구 정의만으로도 그 대부분을 쓴다. 넘친 부분은 오류 없이 잘려 나가므로 증상만 남는다.

```bash
OLLAMA_CONTEXT_LENGTH=16384 ollama serve   # Windows 트레이 앱은 setx로 환경 변수를 넣고 재시작
```

서버를 그렇게 올린 뒤 **설정 > LLM 프로바이더 > 컨텍스트**에 같은 값(16384)을 적으면, 에이전트가
프롬프트·지식베이스·도구 결과를 그 예산에 맞춰 배분한다. 값을 비워두면 4096으로 가정하고
축약 프롬프트·기억 주입 축소·도구 결과 절삭으로 창 안에 맞춘다(대신 대화 기록이 짧게 실린다).

두 값이 어긋나도 앱이 알아서 맞춘다. 매 턴 `/api/ps`로 서버가 실제로 연 창을 확인해 그 값을
예산으로 쓰고, 설정값과 다르면 대화에 한 번 알린다. Ollama가 자동 업데이트로 재시작되면
`OLLAMA_CONTEXT_LENGTH`를 못 받은 채(서버 로그에 `OLLAMA_CONTEXT_LENGTH:0`) 기본 4096으로
뜨는 일이 있는데, 그때는 완전히 종료했다가 새 터미널에서 다시 띄우면 반영된다.

도구 호출이 필요하므로 `tools` 능력이 있는 모델을 쓴다(`ollama show <model>`의 Capabilities).
사고(thinking)형 모델은 앱이 `reasoning_effort: none`으로 사고 단계를 끈다 — 좁은 창에서는
사고 토큰이 정작 필요한 답과 도구 호출을 밀어내기 때문이다.

## 구조

```
src/
├─ main/                # Electron main process
│  ├─ agent/            #   대화 루프(loop.ts), 세션 저장(sessions.ts)
│  ├─ llm/              #   프로바이더 추상화 + 키 암호화 저장
│  ├─ permissions/      #   승인 게이트웨이, 정책 규칙, 감사 로그
│  ├─ memory/           #   지식베이스: 저장/회상/추출
│  ├─ tools/            #   fs_read, fs_write, fs_list, shell_exec
│  └─ storage/          #   userData/data 아래 JSON 저장소
├─ preload/             # contextBridge API (채널 화이트리스트)
├─ renderer/            # React UI (채팅, 승인, 설정, 지식베이스)
└─ shared/              # 공용 타입, preload API 계약
```

## 현재 구현 범위와 로드맵 대비 차이

- 저장소: 설계의 SQLite 대신 JSON 파일 저장소로 시작 (네이티브 모듈 빌드 의존성 제거).
  인터페이스가 `storage/`에 격리되어 있어 better-sqlite3로 교체 가능.
- 셸: node-pty 대신 child_process.exec (비인터랙티브, 타임아웃 120초).
- 기억 회상: 키워드 스코어링. 로컬 임베딩 벡터 검색은 M6에서 교체 예정.
  조회는 부수효과 없는 `queryMemories`, 실제 주입은 사용 이력을 남기는 `recallMemories`로 분리되어 있다 —
  UI 검색이나 미리보기가 회상 통계를 오염시키지 않도록.
- 점검 대기함(중복·노후·형식·출처)은 전부 룰 기반이라 LLM 호출이 없다. 모순 탐지는 미구현.
- 미구현: 스크린샷/클립보드/앱 실행 도구.
