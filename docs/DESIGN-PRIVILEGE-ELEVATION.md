# 권한 상승 (sudo/root) 설계

에이전트가 관리자 권한을 필요로 하는 작업을 요청할 때의 처리 방식.
설계 목표는 하나다 — **에이전트는 root 권한도, 그것을 얻는 수단(비밀번호)도 갖지 않는다.**
root로 실행되는 것은 사용자가 그 자리에서 매번 승인한 단일 자식 프로세스뿐이다.

## 위협 모델

이 앱의 에이전트는 파일·HTTP 응답·다른 에이전트의 위임 메시지·문서 첨부를 읽는다.
그 안에 "관리자 권한으로 다음을 실행하라"는 문장이 섞여 들어올 수 있고, LLM은 그것을
사용자의 지시와 완벽하게 구분하지 못한다. 따라서 다음을 전제로 설계한다.

- 에이전트가 만들어 낸 명령은 **언제나 신뢰할 수 없는 입력**이다.
- 프로세스에 한 번 들어온 비밀번호는 유출된 것으로 간주한다 (메모리 덤프·크래시 리포트·로그).
- 한 번 저장된 허용 규칙은 사람이 없는 시각에도 그대로 발동한다.

방어의 핵심은 "나쁜 명령을 걸러내기"가 아니라 **모든 상승 실행 앞에 사람을 세우는 것**이다.
블록리스트는 우회 가능하지만, 매번 뜨는 승인 대화상자와 OS 비밀번호 창은 우회할 수 없다.

## 5가지 불변 규칙

1. **비밀번호는 OS만 받는다.** 앱은 상승 대화상자를 띄우지 않는다. Linux는 polkit,
   macOS는 Authorization Services, Windows는 UAC가 자격증명을 수집하고, 우리 프로세스는
   성공/실패만 안다. 비밀번호는 IPC·렌더러·LLM 프롬프트·대화 기록·감사 로그 어디에도 지나가지 않는다.
2. **상승은 별도 도구로만 가능하다.** `shell_exec`는 `sudo`/`doas`/`pkexec`/`su`/`runas`가
   섞인 명령을 권한 게이트웨이에서 하드 블록한다. 우회로가 남으면 나머지 방어가 무의미하다.
3. **승인은 매번, 1회용.** `elevate` 등급 호출은 권한 규칙 평가를 아예 건너뛴다.
   "이 세션에서 허용"·"항상 허용"이 존재하지 않으며, 승인 결과로 규칙이 저장되지 않는다.
   `rules.json`에 이 도구의 규칙을 넣는 것도 정책 계층에서 거부된다.
4. **사용자가 화면 앞에 있을 때만.** 창이 없거나 숨겨져 있거나 최소화돼 있으면 요청 자체가 거부된다.
   스케줄러·피어 위임처럼 사람이 없는 경로에서 시작된 작업에는 도구가 아예 노출되지 않는다.
5. **기본은 꺼짐.** 설정에서 사용자가 명시적으로 켜기 전까지 도구 정의가 LLM에 전달되지 않는다.

## 실행 경로

```
에이전트  ──shell_exec_elevated(op, ...)──▶  권한 게이트웨이
                                              │ ① 기능 켜짐?      아니면 거부
                                              │ ② 무인 실행?      맞으면 거부
                                              │ ③ 사용자 화면 앞?  아니면 거부
                                              │ ④ 승인 대화상자 (argv 원문 표시, 2분 제한)
                                              ▼
                                          OS 상승 실행기
                                              │ pkexec / Authorization Services / UAC
                                              │ → OS가 비밀번호를 받는다 (앱은 못 본다)
                                              ▼
                                     root 자식 프로세스 1회 실행
                                              │
                                              ▼
                                      stdout/stderr/exitCode만 회수
```

앱 프로세스는 시작부터 끝까지 일반 사용자 권한으로 남는다. root인 것은 자식 프로세스뿐이고,
그 프로세스는 승인된 argv 하나를 실행하고 죽는다.

## 자유 문자열이 아니라 작업 목록

`command: string`을 받으면 승인 화면에 뜬 글자와 실제로 실행되는 것의 관계를 사용자가 검증할 수 없다
(셸 확장·따옴표·서브셸·`$(...)`). 그래서 `shell_exec_elevated`는 검증 가능한 작업(op)만 받는다.

| op | 인자 | 컴파일 결과 (Linux 예) |
|---|---|---|
| `package_install` | `names[]` | `apt-get install -y <names>` (배포판별 pm 자동 판별) |
| `package_remove` | `names[]` | `apt-get remove -y <names>` |
| `package_update` | — | `apt-get update` (pacman은 `-Sy` 단독의 부분 업그레이드 위험 때문에 거부 — `raw`로 `-Syu`를 쓴다) |
| `service` | `action`, `unit` | `systemctl restart <unit>` |
| `copy_file` | `from`, `to` | `cp -f <from> <to>` |
| `raw` | `argv[]` | `<argv>` 그대로 |

각 인자는 zod 정규식으로 검증하고(패키지명·유닛명에 셸 메타문자 불가), 최종적으로 **argv 배열**로
`execFile`에 넘긴다. 셸을 거치지 않으므로 인자에 `;`나 `$(...)`가 들어 있어도 문자열일 뿐이다.
`raw`도 argv 배열이라 같은 성질을 갖는다 — 승인 화면에 보이는 각 줄이 실행되는 각 인자와 1:1이다.

## 명시적으로 채택하지 않은 방안

**시크릿 저장소에 sudo 비밀번호를 넣고 `sudo -S`로 파이프한다** — 채택하지 않는다.

- `safeStorage`는 같은 사용자로 실행되는 모든 프로세스가 복호화할 수 있다. 프로세스 격리를 주지 않는다.
- 비밀번호가 Node 힙에 남고, 크래시 리포트·코어 덤프로 새어 나갈 수 있다.
- sudo의 존재 이유인 "매 행위마다 사람이 그 자리에 있다"는 검증이 사라진다.
  프롬프트 인젝션 한 번이면 무제한·무인 root가 된다.

**polkit 에이전트가 없을 때 앱이 직접 비밀번호를 묻는 대체 경로** — 채택하지 않는다.
그 순간 규칙 1이 깨진다. polkit 에이전트가 없으면 상승 실행은 그냥 실패하고,
사용자에게 "터미널에서 직접 실행하라"고 안내한다.

## 무인 실행이 필요할 때

스케줄러로 정기 작업을 돌려야 한다면, 답은 에이전트에게 비밀번호를 주는 것이 아니라
**사용자가 OS 수준에서 좁은 정적 허용을 설정하는 것**이다.

```
# sudo visudo -f /etc/sudoers.d/desktop-agent
<사용자> ALL=(root) NOPASSWD: /usr/bin/apt-get update, /usr/bin/systemctl restart <유닛>
```

앱은 이 파일을 자동으로 만들지 않는다. 사용자가 직접 만들고, 앱은 문구만 안내한다.
권한 범위가 앱 코드가 아니라 OS 설정에 박히므로, 에이전트가 인젝션으로 장악돼도
그 두 명령 이상은 할 수 없다. (이 경로를 쓰더라도 `shell_exec`의 sudo 하드 블록은 유지되며,
해당 명령은 `raw` op로 승인을 거쳐 실행된다.)

## 알려진 한계

**polkit의 인증 보존(`auth_admin_keep`).** 배포판 기본값에서 pkexec의 기본 액션은 활성 세션에 대해
인증을 약 5분간 보존한다. 즉 5분 안의 두 번째 상승 실행에서는 OS 비밀번호 창이 뜨지 않을 수 있다.
**앱의 승인 대화상자는 그와 무관하게 매번 뜨므로** 사람의 확인은 언제나 1회당 1번 이루어지지만,
비밀번호 입력까지 매번 강제하고 싶다면 다음 규칙을 설치한다.

```javascript
// /etc/polkit-1/rules.d/49-no-auth-keep.rules
polkit.addRule(function (action, subject) {
  if (action.id == 'org.freedesktop.policykit.exec') {
    return polkit.Result.AUTH_ADMIN  // keep 없이 매번 인증
  }
})
```

이 규칙은 pkexec 전반에 적용된다는 점을 감안하고 설치할 것.

**Windows의 출력 회수.** `Start-Process -Verb RunAs`는 파이프 리다이렉션과 함께 쓸 수 없어,
상승된 PowerShell이 임시 파일에 출력을 쓰고 앱이 그 파일을 읽는다. 관리자 권한으로 만들어진
파일이므로 내용이 민감하다면 실행 후 즉시 삭제된다(구현에서 처리).

**macOS의 문자열 경유.** Authorization Services 경로(`do shell script`)는 argv 배열을 받지 않고
셸 문자열을 받는다. 구현에서 각 인자를 POSIX 작은따옴표로 감싼 뒤 AppleScript 문자열로
이스케이프하지만, Linux 경로만큼 구조적으로 안전하지는 않다. 장기적으로는 `SMAppService`
특권 헬퍼로 옮기는 것이 정석이다.

## 구현 위치

| 파일 | 역할 |
|---|---|
| `src/main/permissions/elevation.ts` | 기능 on/off, 사용자 재실(在席) 판정, 도구 이름 상수 |
| `src/main/permissions/gateway.ts` | `checkElevated` 전용 경로, `shell_exec`의 상승 시도 하드 블록 |
| `src/main/permissions/policies.ts` | 상승 도구의 허용 규칙 저장 거부 |
| `src/main/tools/elevated.ts` | op → argv 컴파일, OS별 상승 실행기 |
| `src/main/tools/index.ts` | 기능이 켜져 있고 사람이 지켜보는 턴에서만 도구 노출 |
| `src/main/agent/{scheduler,tasks}.ts`, `src/main/network/manager.ts` | 무인 실행 경로 표시(`unattended`) |
| `src/renderer/src/approval/ApprovalModal.tsx` | 상승 전용 승인 화면 (argv 원문, 1회용 버튼만) |

`shell_exec`의 상승 차단은 명령 문자열 어디에 있든 잡도록 따옴표·서브셸·변수 대입 뒤까지 본다
(`bash -c 'sudo id'`, `$(sudo id)`, `CMD=sudo` 모두 차단). 부수적으로 `grep su` 같은 무해한 명령이
걸릴 수 있는데, 차단 메시지가 대안(`shell_exec_elevated`)을 알려 주므로 에이전트가 막히지는 않는다.

## 남아 있는 위험

MCP 서버와 외부 연동 도구도 같은 게이트웨이를 지나지만 위험 등급은 `execute`이고,
이들은 규칙으로 "항상 허용"을 저장할 수 있다. 사용자가 **root로 실행되는 MCP 서버**를 등록하면
그 경로로는 이 문서의 보호가 적용되지 않는다. MCP 서버는 사용자 권한으로만 등록할 것.

## 감사

상승 실행은 감사 로그에 `elevated: true`와 실행된 argv 전체를 남기고, 승인 여부와 무관하게
항상 OS 알림을 띄운다. 비밀번호는 어느 경로로도 지나가지 않으므로 argv를 그대로 남겨도 안전하다.
