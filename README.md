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
3. **지식베이스** 탭에서 에이전트가 축적한 기억(사용자·요구사항·교훈·참조)을 조회/삭제.

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
- 미구현: 스크린샷/클립보드/앱 실행 도구.
