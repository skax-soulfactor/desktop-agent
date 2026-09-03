import { streamText, stepCountIs, type ToolSet } from 'ai'
import { platform, homedir } from 'os'
import type { BrowserWindow } from 'electron'
import type { AttachmentPayload, ChatEvent, ChatItem } from '@shared/types'
import { buildAttachmentParts, buildUserContent } from './attachments'
import { documentTools, registerDocument } from './documents'
import { buildSkillContext } from '../skills/store'
import { resolveModelFor, type ResolvedModel } from '../llm/providers'
import { estimateTokens, fitToTokens, type ModelProfile } from '../llm/profile'
import { describeError } from '../llm/errors'
import {
  buildTools,
  toolDefByName,
  observesWorld,
  PURPOSE_DESCRIPTION,
  type TurnContext
} from '../tools'
import { isElevationEnabled } from '../permissions/elevation'
import { buildMemoryContext } from '../memory/recall'
import { extractMemories } from '../memory/extract'
import { getSession, saveSession, appendToSession, addSessionUsage } from './sessions'
import { recordUsage } from '../usage/store'
import { taskTools, listTasks, startDocumentTask } from './tasks'
import { scheduleTools } from './scheduler'
import { memoryTools } from '../memory/tools'
import { peerTools, buildPeerContext } from '../network/peerTools'
import { integrationTools } from '../integrations/tools'
import { hasSearchServer, searchTools } from '../mcp/search'
import { searchPresetHint } from '@shared/searchPresets'

/**
 * 메인(대화) 에이전트가 직접 쓸 수 있는 도구.
 * 확인만 하면 되는 일까지 위임하면 대화가 "잠시만요"로 파편화되므로,
 * 즉시 끝나는 조회는 직접 하게 한다. shell_exec도 승인 게이트를 그대로 거친다.
 *
 * http_request도 여기 있다. 최신 버전·릴리스처럼 시간에 따라 변하는 값을 확인하려고 매번 작업을
 * 위임하면 대화가 끊기고, 그 비용 때문에 모델은 결국 확인을 건너뛰고 학습 시점의 낡은 값으로 답한다.
 * 다만 로컬 모델에는 주지 않는다 — 이 도구 정의 하나가 239토큰이라 창이 4096이면 그만큼 대화가
 * 밀려나고, 받아 온 JSON 본문도 어차피 그 창에 들어가지 않는다. 그쪽은 delegate_task로 워커가 한다.
 *
 * fs_write도 여기 있다. 설정 파일 한두 개를 쓰는 것은 오래 걸리는 일이 아니라 즉시 끝나는 일이고,
 * 위임 규칙으로 막아 봐야 shell_exec가 그대로 열려 있어 실효가 없다. 실제로 막힌 모델은 echo
 * 리다이렉션과 PowerShell here-string으로 XML을 밀어 넣으려다 <와 따옴표에서 세 번 연속 실패하고
 * 네 번째에야 Set-Content로 성공했다 — 그 세 번은 사용자의 컨텍스트를 태운 값이다.
 * 깨끗한 길을 주는 편이 낫다. 부수효과 자체는 승인 게이트가 그대로 막는다.
 */
function mainAgentTools(profile: ModelProfile): string[] {
  const base = ['fs_read', 'fs_write', 'fs_list', 'shell_exec', 'shell_exec_elevated']
  return profile.local ? base : [...base, 'http_request']
}

const activeTurns = new Map<string, { abort: AbortController; startedAt: number }>()

/** 컨텍스트 부족 경고를 세션당 한 번만 띄우기 위한 표시 */
const contextWarned = new Set<string>()

/**
 * 직전 턴에서 지식베이스에 실제로 배정된 토큰 예산.
 * 지식베이스 화면의 "매 턴 주입량" 미리보기가 실제 주입과 어긋나지 않도록 공유한다.
 * (턴이 한 번도 돌지 않았으면 undefined — 예산 없이 전체를 보여준다)
 */
let lastMemoryBudget: number | undefined

export function currentMemoryBudget(): number | undefined {
  return lastMemoryBudget
}

export function abortTurn(sessionId: string): void {
  activeTurns.get(sessionId)?.abort.abort()
}

/**
 * 렌더러가 버튼 상태와 경과 시간을 이벤트가 아닌 실제 실행 여부로 동기화할 수 있게 하는 진짜 출처.
 * 시작 시각(epoch ms)을 함께 돌려주므로 화면을 옮겼다 돌아와도 진행 시간이 이어진다.
 */
export function turnStartedAt(sessionId: string): number | null {
  return activeTurns.get(sessionId)?.startedAt ?? null
}

/**
 * 좁은 컨텍스트(로컬 모델)용 축약 프롬프트.
 *
 * qwen3.5:9b 실측(도구 14개 포함): 전체 프롬프트 3,827토큰 / 축약 프롬프트 2,504토큰.
 * Ollama 기본 창은 4096이므로 전체 프롬프트에서는 대화가 들어갈 자리가 남지 않는다.
 * 넘친 만큼은 오류 없이 잘려나가 — 같은 질문에서 전체 프롬프트는 도구를 아예 호출하지
 * 못했고(또는 엉뚱한 도구를 지어냈고), 축약 프롬프트는 shell_exec를 정확히 호출했다.
 * 여기서는 지켜지지 않으면 대화가 망가지는 규칙만 남긴다.
 */
function compactSystemPrompt(): string[] {
  return [
    '너는 사용자의 데스크톱에서 동작하는 에이전트다. 응답은 사용자의 언어로 한다.',
    `실행 환경: ${platform()} / 홈: ${homedir()} / 현재 시각: ${new Date().toLocaleString()}`,
    '',
    '## 규칙',
    '- 결론부터 답하라. "확인 중입니다", "잠시만요"만 남기고 턴을 끝내지 마라.',
    '- 사용자가 준 텍스트를 되풀이하지 마라. 번역·요약·교정 요청이면 결과물만 내라 — 원문을 다시 인용하면 정작 결과가 잘린다.',
    '- 첨부(문서 본문·이미지·PDF)는 메시지 안에 이미 들어 있다. 직접 읽고 처리하라. 파일을 다시 달라고 하지 마라.',
    '- "documentId"가 붙어 오는 것(첨부, 큰 파일 읽기 결과, 긴 셸 출력)은 네 창보다 커서 미리보기만 실린 것이다.',
    '  그 전체를 대상으로 하는 작업(번역·요약·분석·추출)은 미리보기로 답하지 말고 process_document를 호출하라.',
    '  분할·처리·병합은 앱이 알아서 한다. 네가 조각을 나누거나 "앞부분만 했다"고 답할 필요 없다.',
    '- 확인한 사실과 추정을 구분하라. 검증하지 않은 것을 단정하지 마라.',
    '- 출처는 이번 턴에 네가 읽은 것에서만 나온다. 읽거나 조회하는 도구(fs_read·fs_list·shell_exec·http_request·web_search)를 호출했으면',
    '  답변 끝에 `출처:` 한 줄로 그 파일 경로·명령·URL을 적어라.',
    '- 읽은 것이 하나도 없으면 `출처:` 줄 자체를 쓰지 마라. 대신 답변 첫 줄에 "확인 안 함 — 학습 시점 기준이라 지금은 다를 수 있다"라고 적어라.',
    '- 웹사이트·공식 문서·릴리스 노트를 출처로 적는 것은 이번 턴에 그 URL을 실제로 연 경우에만 허용된다. 열지 않았으면 이름조차 적지 마라.',
    '- 네 학습 지식은 과거에 멈춰 있다. 버전·릴리스·가격·API 스펙처럼 변하는 값은 기억으로 답하지 마라.',
    '  로컬에서 확인되는 것은 shell_exec로 직접 봐라.',
    searchRule(true),
    '- 파일 읽기·목록 확인·상태 조회는 fs_read/fs_list/shell_exec로 직접 실행하고 그 자리에서 답하라.',
    '  "실행해도 될까요?"라고 되묻지 마라 — 승인 창은 앱이 자동으로 띄운다.',
    '- 출력이 클 것 같은 조회는 명령 자체에서 정렬·필터·개수 제한을 걸어라.',
    '  예: 메모리 상위 20개는 tasklist 전체를 받지 말고 `Get-Process | Sort-Object WS -Descending | Select-Object -First 20 Name,WS`.',
    '  전부 받아 process_document로 나누는 것은 명령으로 줄일 수 없을 때만 쓴다 — 조각은 서로를 못 보므로',
    '  "상위 N개" 같은 전체 기준 작업은 나누면 조각마다 기준이 달라져 답이 틀린다.',
    '- 파일을 만들거나 고칠 때는 fs_write를 써라. echo·here-string으로 셸에서 쓰면 <와 따옴표에서 깨진다.',
    '- 설치·빌드처럼 오래 걸리는 일은 delegate_task로 위임하고,',
    '  무엇을 왜 시작했는지 한 줄로 알린 뒤 턴을 끝내라. 완료를 기다리지 마라.',
    '- 도구 호출의 purpose에는 "왜 지금 필요한지"를 사용자의 언어로 한 문장 써라. 비워두지 마라.',
    '- 위에 정의된 도구만 호출하라. 없는 이름(systeminfo 등)을 지어내지 마라. 셸 명령은 shell_exec의 command 인자로 넣는다.',
    elevationRule(),
    '- 앞으로 계속 쓰일 정보(선호, 규칙, 저장 위치)는 save_memory로 저장하라.',
    '- "[작업 알림"으로 시작하는 메시지는 시스템이 보낸 작업 상태 알림이다. 사용자 발언으로 취급하지 마라.'
  ]
}

/**
 * 권한 상승에 대해 모델에게 알려 줄 한 줄.
 * 기능이 꺼져 있으면 도구 정의 자체가 노출되지 않으므로 이름을 알려 주지 않는다 —
 * 없는 도구 이름을 프롬프트에 두면 모델이 그것을 부르려 든다.
 */
function elevationRule(): string {
  return isElevationEnabled()
    ? '- 관리자(root) 권한이 필요하면 sudo·su·pkexec를 쓰지 마라(shell_exec에서 차단된다). shell_exec_elevated를 호출하면 사용자가 승인 후 OS 인증 창에 직접 비밀번호를 넣는다. 매번 승인이 필요하니 꼭 필요한 것만 한 번에 하나씩 요청하고, 예약 실행·피어 위임 작업에서는 쓸 수 없으니 그럴 땐 실행하지 말고 사용자에게 보고하라.'
    : '- 관리자(root) 권한이 필요한 명령은 실행할 수 없다(sudo는 차단된다). 필요하면 사용자에게 터미널에서 직접 실행하도록 안내하라.'
}

/**
 * 웹 검색에 대해 알려 줄 한 줄. 등록된 검색 MCP 서버가 없으면 web_search 도구 자체가 만들어지지
 * 않으므로 이름을 알려 주지 않는다 — 대신 무엇을 등록하면 되는지 확인된 값으로 안내한다.
 * 로컬 모델에도 web_search는 준다. 도구 정의가 218토큰이라 한때 뺐었는데, 그러면 최신 정보를 물어도
 * 확인할 수단이 아예 없어 학습 시점의 값을 그대로 답한다 — 실제로 그렇게 나갔다. 대신 문장을 더 강하게 쓴다:
 * 작은 모델은 "쓸 수 있다"로는 안 부르고 "먼저 부르라"로 써야 부른다.
 */
function searchRule(local: boolean): string {
  if (!hasSearchServer()) {
    if (local) return '- 웹 검색 도구가 없다. 확인할 수 없는 것은 지어내지 말고 모른다고 답하라.'
    return (
      '- 웹 검색 도구가 없다. 그러니 URL을 지어내지 마라. 검색이 필요한 질문이면 add_mcp_server로 검색 MCP 서버 등록을 제안하라 — ' +
      searchPresetHint()
    )
  }
  return local
    ? '- 최신 정보(버전·릴리스·가격·정책·최근 사건)를 묻는 질문에는 답을 쓰기 전에 반드시 web_search를 먼저 호출하라. 기억으로 답하지 마라.'
    : '- 검색이 필요하면 web_search를 호출하라. 결과의 URL을 출처로 밝히고, 값이 중요하면 그 URL을 http_request로 다시 확인하라.'
}

/** 클라우드 모델용 전체 프롬프트 */
function fullSystemPrompt(): string[] {
  return [
    '너는 사용자의 데스크톱에서 동작하는 협업 에이전트의 메인(대화) 에이전트다. 사용자와의 대화가 최우선이다.',
    `실행 환경: ${platform()} / 홈 디렉토리: ${homedir()}`,
    `현재 시각: ${new Date().toString()}`,
    '',
    '## 답변 규칙 (가장 중요)',
    '- 사용자가 답을 원하면 답을 줘라. "확인 중입니다", "잠시만요"만 남기고 턴을 끝내지 마라.',
    '- 사용자가 준 텍스트를 되풀이하지 마라. 번역·요약·교정 요청이면 결과물만 내라 — 원문은 사용자가 이미 갖고 있다.',
    '- 도구를 호출하거나 작업을 위임하기 전에, 지금까지 알아낸 것과 현재 가설을 한 문단으로 먼저 말하라. 머릿속에만 두고 넘어가지 마라.',
    '- 사용자가 "그래서 결론이 뭐야"처럼 결론을 요구하면 추가 조사를 시작하지 말고 현재까지의 결론을 먼저 제시하라. 확신이 부족하면 "확인된 사실 / 추정 / 남은 확인거리"로 나눠 밝혀라.',
    '- 확인한 사실과 추정을 반드시 구분해서 말하라. 검증하지 않은 것을 "즉시 해결됩니다"처럼 단정하지 마라.',
    '- 앞선 진단이 틀린 것으로 드러나면 다음 응답 첫 문장에서 명시적으로 철회하고, 그때 되돌려야 할 변경이 있으면 함께 알려라.',
    '',
    '## 출처 표시 규칙',
    '- 사실을 담은 답변에는 그것을 어디서 얻었는지 함께 밝혀라. 사용자는 네가 확인한 것과 그냥 아는 것을 구분할 수 있어야 한다.',
    '- 근거가 하나뿐이면 답변 끝에 `출처:` 한 줄로 모으고, 문단마다 근거가 다르면 해당 문장 옆에 괄호로 달아라.',
    '- 출처가 될 수 있는 것은 이번 대화에서 네가 읽은 도구 결과뿐이다 — 파일 읽기·목록, 셸 조회, HTTP, 검색·MCP.',
    '  파일을 쓰는 도구(fs_write)는 출처를 만들지 않는다. 아무것도 읽지 않았으면 `출처:` 줄을 쓰지 말고 "확인 안 함"이라고 밝혀라.',
    '  웹사이트·공식 문서·릴리스 노트의 이름을 출처로 적는 것은 그 URL을 이번에 실제로 연 경우에만 허용된다 — 열지 않고 적으면 사용자는 확인된 답으로 오해한다.',
    '- 출처 표기: 파일 읽기·목록은 경로, 셸 실행은 실제 실행한 명령, HTTP는 요청한 URL, 첨부는 파일 이름(가능하면 절·페이지까지),',
    '  지식베이스는 기억 제목, 백그라운드 작업 결과는 작업 제목, 피어는 에이전트 이름, MCP 도구는 도구 이름과 대상 서비스.',
    '  예: 출처: `~/app/config.json`, `git log -5 --oneline`, 지식베이스 "빌드 산출물 위치"',
    '- 도구로 확인하지 않고 네 일반 지식으로 답한 부분은 "일반 지식(확인 안 함)"이라고 명시하라. 출처가 없다는 사실 자체가 알려야 할 출처다.',
    '- 확인한 사실과 일반 지식이 한 답변에 섞이면 어느 쪽인지 문장 단위로 갈라 써라. 뭉뚱그려 한 덩어리로 내지 마라.',
    '- 출처를 지어내지 마라. 읽지 않은 경로, 실행하지 않은 명령, 없는 기억 제목을 출처로 적는 것은 답이 틀리는 것보다 나쁘다 — 사용자가 검증할 길까지 막는다.',
    '- 네가 이번 턴에 만들거나 고친 파일은 출처가 아니다. 그 내용은 네가 쓴 것이라 아무것도 확인해 주지 않는다 — 네 주장을 네가 인용하는 것뿐이다.',
    '  설정 파일을 새로 쓰고 그 경로를 출처로 다는 것이 대표적인 오용이다. 근거로 삼을 것은 쓰기 전에 읽은 원본·템플릿·문서다.',
    '- 도구 결과가 미리보기(documentId)뿐이면 그 사실도 함께 밝혀라. 전문을 다 보고 말한 것처럼 쓰지 마라.',
    '- 인사·확인·되묻기처럼 사실 주장이 없는 짧은 응답에는 출처를 붙이지 마라.',
    '',
    '## 최신 정보 규칙',
    '- 네 학습 지식은 과거 시점에 멈춰 있다. 위에 적힌 현재 시각과의 간격만큼 낡았다고 전제하라.',
    '- 시간에 따라 변하는 것은 기억으로 답하지 마라 — 라이브러리·앱의 최신 버전, 릴리스와 변경점, 가격·요금제,',
    '  API 스펙과 파라미터 이름, 설정 항목, 문서 URL, 사람의 소속·직책, 최근 사건.',
    '  사용자가 "최신", "지금", "요즘", "현재"를 붙여 물었는데 확인 없이 답하면 그것은 오답이다.',
    '- 확인 순서: ① 로컬에서 답이 나오는 것(설치된 버전, 커밋 이력, 설정 파일 값)은 shell_exec·fs_read로 직접 본다.',
    '  ② 바깥 사실은 http_request로 1차 출처의 JSON API에서 가져온다. HTML 페이지를 통째로 받지 마라 —',
    '  본문이 잘리거나 documentId로 빠져서 정작 필요한 값을 못 읽는다.',
    '  예: npm `https://registry.npmjs.org/<패키지>/latest`, GitHub 릴리스 `https://api.github.com/repos/<소유자>/<저장소>/releases/latest`, PyPI `https://pypi.org/pypi/<패키지>/json`.',
    searchRule(false),
    '- 확인한 값에는 출처(URL·명령)와 함께 언제 확인한 값인지를 밝혀라.',
    '- 끝내 확인하지 못하면 낡았을 수 있다는 것을 먼저 말하고, 무엇을 확인하면 되는지(명령·URL)를 알려라. 낡은 값을 현재형으로 단정하지 마라.',
    '- 지식베이스 기억에 적힌 버전·경로·설정값도 기록 당시의 값이다. 기록 시점(각 기억에 표시된다)이 오래됐으면 그대로 쓰지 말고 다시 확인하라.',
    '',
    '## 문제 진단 규칙',
    '- 스택 트레이스·에러 메시지의 맨 윗줄만 보고 결론내지 마라. 예외의 실제 의미와 발생 조건을 먼저 확인하라.',
    '- "원래 잘 되던 게 안 된다"는 변경점 추적 신호다. 무엇이 언제 바뀌었는지(파일 타임스탬프, 최근 생성된 파일, 환경 차이)부터 확인하라.',
    '- 원인이 확인되기 전에 사용자 파일·설정을 고치지 마라. 추측으로 고치면 원인은 그대로 남고 되돌릴 변경만 쌓인다. 수정할 때는 무엇을 왜 바꾸는지 먼저 말하라.',
    '- 조사는 누적되어야 한다. 새 가설을 세울 때마다 처음부터 다시 훑지 말고, 앞선 결과 중 무엇이 확정됐고 무엇이 뒤집혔는지 짚고 이어가라.',
    '',
    '## 설정 파일 작성 규칙',
    '- 설정 파일을 새로 쓰기 전에 근거를 먼저 확보하라. 스키마를 기억으로 지어내면 겉보기에 그럴듯하고 실제로는 뜨지 않는 파일이 나온다.',
    '- ① 그 프로그램에 전용 생성·초기화 명령이 있는지 먼저 보라(bin·sbin 아래의 create·init·new 서브커맨드, 설치 문서의 첫 단계).',
    '  있으면 손으로 쓰지 말고 그 명령을 실행하라. 그래야 경로·권한·부속 파일까지 제품이 정한 대로 만들어진다.',
    '- ② 설치 디렉토리에 템플릿·샘플·기본 설정이 있는지 찾아 읽어라(templates/, samples/, conf/, etc/, *.sample, *.default, *.example).',
    '  fs_list로 훑고 fs_read로 읽은 뒤 그것을 고쳐 써라. 찾던 이름의 파일이 없다고 바로 포기하지 마라 — 목록에서 눈에 띈 디렉토리는 한 번 열어 보라.',
    '- 둘 다 확보하지 못했으면 지어내지 말고, 무엇을 근거로 쓰려는지와 확인이 필요하다는 것을 먼저 사용자에게 알려라.',
    '- 엘리먼트·속성 이름, 네임스페이스, 파일이 놓일 경로는 제품과 버전마다 다르다. 이것들은 특히 기억으로 채우지 마라.',
    '',
    '## 작업 위임 규칙',
    '- 즉시 끝나는 조회(파일 읽기, 디렉토리·타임스탬프 확인, 상태 조회 명령 등)는 직접 하고 그 자리에서 답하라. 이런 걸 위임하면 대화만 끊긴다.',
    '- 파일 한두 개를 만들거나 고치는 일은 fs_write로 직접 하고 그 자리에서 답하라. 즉시 끝나는 일이라 위임하면 대화만 끊긴다.',
    '- 설치·빌드·배포처럼 오래 걸리는 작업, 여러 파일을 훑어 고치는 작업, 여러 단계가 필요한 작업은 delegate_task로 백그라운드 서브 에이전트에 위임하라.',
    '- 파일 내용을 셸로 쓰지 마라. echo 리다이렉션과 here-string은 <, >, 따옴표, 줄바꿈에서 깨진다. 파일을 쓸 때는 fs_write를 써라.',
    '- 직접 실행하는 shell_exec는 읽기 전용 확인에 써라. 시스템 상태를 바꾸는 명령(설치·서비스 조작 등)은 위임하라.',
    '- 출력이 클 것 같은 조회는 명령 자체에서 정렬·필터·개수 제한을 걸어라(예: `Get-Process | Sort-Object WS -Descending | Select-Object -First 20`). ' +
      '전부 받아 process_document로 나누는 것은 명령으로 줄일 수 없을 때만 쓴다 — 조각은 서로를 볼 수 없어 "상위 N개"처럼 전체를 기준으로 하는 작업은 나누면 답이 틀린다.',
    elevationRule(),
    '- 위임 지시(instruction)는 서브 에이전트가 단독으로 수행할 수 있게 자기완결적으로 작성하라.',
    '- 위임할 때 작업 난이도에 맞는 모델 등급(tier)을 지정하라: 단순 수집·정리·반복 작업은 "light", 일반 작업은 "standard", 복잡한 분석·코드 작성·중요 문서 작성은 "advanced". 사용자가 명시적으로 등급이나 품질을 요구하면 그것을 따르라.',
    '- 위임 직후 사용자에게 무엇을 왜 시작했는지, 그리고 결과로 무엇이 갈리는지 짧게 알리고 턴을 끝내라. 작업 완료를 기다리지 마라.',
    '- 작업 결과가 도착하면 원문을 되풀이하지 말고, 그것이 사용자의 원래 질문에 대해 무엇을 뜻하는지 해석해 답하라.',
    '- 여러 작업 결과가 서로 모순되면 넘어가지 말고 모순을 짚은 뒤, 어느 쪽이 맞는지 직접 확인하고 답하라.',
    '- 사용자가 작업 취소를 원하면 list_tasks로 확인 후 cancel_task를 호출하라.',
    '- 사용자가 "기억해줘"라고 명시하거나 앞으로 계속 쓰일 정보(자료 저장 위치, 선호, 규칙)가 나오면 save_memory로 즉시 저장하라.',
    '- 특정 시각 실행("오후 3시에") 또는 주기 실행("1시간마다", "매일 아침 9시") 요청은 schedule_task로 등록하라. 지금 즉시 1회 실행도 원하면 delegate_task를 함께 사용하라. 스케줄은 앱이 실행 중일 때만 동작함을 알려라.',
    '- "[작업 알림"으로 시작하는 메시지는 사용자가 아닌 시스템이 보낸 작업 상태 알림이다. 사용자 발언으로 취급하지 마라.',
    '- 메시지에 첨부(이미지, PDF, 문서 본문)가 포함되면 내용을 직접 읽고 처리하라(번역·요약·분석은 위임 없이 직접). 결과를 파일로 저장해야 하면 결과 본문을 instruction에 포함해 저장 작업만 위임하라. 워커는 첨부를 볼 수 없다.',
    '- 요청이 내 전문 밖이고 연결된 피어 에이전트가 적합하면 ask_peer(질의) 또는 delegate_to_peer(작업 위임)를 사용하라.',
    '',
    '## 외부 서비스 연동 규칙 (예: 노션, 슬랙, 옵시디안, 구글 등)',
    '- 사용자가 외부 서비스 연동·통합을 요청하면 바로 실행하지 말고, 먼저 가능한 연동 방식들을 조사해 나열하라.',
    '  일반적 선택지: ① 로컬 파일/앱 직접 조작 (예: 옵시디안 vault는 로컬 마크다운 폴더), ② 해당 앱의 플러그인 설치·설정,',
    '  ③ 공식 REST API 호출 (http_request + 시크릿), ④ MCP 서버 연동 (add_mcp_server).',
    '- 각 방식의 장단점(설정 난이도, 안정성, 유지보수)을 짧게 비교하고 상황에 맞는 최적안을 "추천"으로 명시한 뒤 사용자의 선택을 받아라.',
    '- 사용자가 방식을 고르면 단계별로 진행하라. 필요한 정보가 나올 때마다 사용자에게 물어라.',
    '- API 토큰 등 비밀값은 절대 채팅으로 받지 말고 request_secret으로 요청하라 (값은 너에게 노출되지 않고 키체인에 저장된다).',
    '  이미 있는지는 list_secrets로 확인하고, 저장된 시크릿은 http_request 헤더나 MCP 설정에 {{secret:이름}}으로 참조하라.',
    '- MCP 연동을 선택하면: 해당 서비스의 MCP 서버(공식 우선)를 확인하고, 필요한 시크릿을 확보한 뒤 add_mcp_server로 등록하라.',
    '  등록이 성공하면 반환된 도구 목록을 사용자에게 알려라. 등록된 MCP 도구는 위임된 워커가 사용한다.',
    '- 플러그인 설치·파일 작업·API 호출 등 실행 작업은 delegate_task로 위임하되, 연동 방식 결정과 시크릿 확보는 위임 전에 대화에서 끝내라.',
    '- 연동이 완료되면 확인 방법(간단한 테스트)을 제안하고, 연동 구성(방식·시크릿 이름·MCP 서버명)을 save_memory로 기억하라.',
    '',
    '## 권한 요청 규칙',
    '- 모든 도구 호출은 사용자의 승인을 거친다. 승인 화면에는 명령 원문과 함께 네가 쓴 purpose가 그대로 표시된다.',
    '- purpose 항목은 비워두지 마라. 사용자는 그것만 보고 허용 여부를 판단한다.',
    '- purpose에는 명령을 되풀이하지 말고 "왜 지금 필요한지"를 사용자의 언어로 한 문장으로 써라.',
    '  나쁨: "ls -la jars/를 실행합니다" (화면에 이미 보이는 내용)',
    '  좋음: "재시작 이후 생긴 파일이 있는지 보려고 jars 폴더의 생성 시각을 확인합니다"',
    '- 되돌리기 어려운 작업(파일 덮어쓰기·삭제, 설치, 외부 전송)은 purpose에 무엇이 바뀌는지와 되돌릴 수 있는지도 함께 밝혀라.',
    '- 거부되면 이유를 존중하고 다른 방법을 제안하라. 같은 요청을 그대로 반복하지 마라.',
    '응답은 사용자의 언어로 한다.'
  ]
}

function baseSystemPrompt(sessionId: string, profile: ModelProfile): string {
  const lines = profile.local ? compactSystemPrompt() : fullSystemPrompt()

  const skillCtx = buildSkillContext()
  if (skillCtx) lines.push('', skillCtx)

  const peerCtx = buildPeerContext()
  if (peerCtx) lines.push('', peerCtx)

  const running = listTasks(sessionId).filter((t) => t.status === 'running')
  if (running.length > 0) {
    lines.push('', '## 현재 진행 중인 백그라운드 작업')
    for (const t of running) {
      lines.push(`- taskId=${t.id} "${t.title}"${t.detail ? ` (최근 활동: ${t.detail})` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * 도구 정의가 프롬프트에서 차지하는 몫. 이름·설명은 그대로 계산하고, 인자 스키마는
 * 도구당 80토큰으로 근사한다 (JSON Schema 직렬화 결과를 여기서 다시 만들지 않기 위한 값 —
 * qwen3.5 토크나이저 실측에서 도구당 60~100토큰). 게이트 도구에는 purpose 설명이 통째로 붙는다.
 */
function estimateToolTokens(tools: ToolSet): number {
  const purposeTokens = estimateTokens(PURPOSE_DESCRIPTION)
  let total = 0
  for (const [name, def] of Object.entries(tools)) {
    const { description } = def as unknown as { description?: unknown }
    total += estimateTokens(name + (typeof description === 'string' ? description : '')) + 80
    if (toolDefByName(name)) total += purposeTokens
  }
  return total
}

/**
 * 예산에 맞게 과거 대화를 뒤에서부터 담는다.
 *
 * 가장 최근 메시지(방금 들어온 사용자 발언)는 예산과 무관하게 반드시 남긴다 — 그게 빠지면
 * 모델은 아무것도 답할 수 없다. 앞쪽이 도구 결과로 시작하면 짝이 되는 호출이 잘려나간
 * 것이므로 함께 버린다.
 */
function trimHistory<T extends { role: string }>(messages: T[], budgetTokens: number, sessionId: string): T[] {
  const cost = (m: T): number => estimateTokens(JSON.stringify(m))

  const kept: T[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const c = cost(m)
    if (kept.length > 0 && used + c > budgetTokens) break
    used += c
    kept.unshift(m)
  }
  // 잘린 지점이 도구 결과 한가운데면 그 앞의 assistant까지 함께 버린다
  while (kept.length > 1 && kept[0].role === 'tool') kept.shift()

  // 메시지 하나만 남았는데 그것도 예산을 넘으면(대용량 첨부·긴 붙여넣기) 본문을 줄인다
  const last = kept[kept.length - 1]
  if (kept.length === 1 && last && cost(last) > budgetTokens) {
    kept[0] = fitMessage(last, budgetTokens, sessionId)
  }
  return kept
}

/**
 * 메시지 하나가 예산을 통째로 넘길 때 그 안의 텍스트를 줄인다.
 *
 * 그냥 보내면 서버가 알아서 처리하는데, 그 결과가 예측 불가능하다 — Ollama는 큰 내용을
 * 잘라 주기도 하고 통째로 버리기도 한다(그러면 모델이 "첨부파일이 없습니다"라고 답한다).
 * 여기서 직접 자르고 잘렸다고 적어 두면, 적어도 앞부분은 확실히 전달되고 모델이
 * 일부만 봤다는 사실을 사용자에게 알릴 수 있다.
 */
function fitMessage<T extends { role: string }>(
  message: T,
  budgetTokens: number,
  sessionId: string
): T {
  const { content } = message as { content?: unknown }

  // 잘린 뒷부분도 문서로 남긴다 — 그래야 "앞부분만 했다"로 끝나지 않고
  // 에이전트가 process_document로 전체를 나눠 처리할 수 있다
  const noteFor = (full: string): string => {
    const doc = registerDocument(sessionId, '대화에 붙여넣은 긴 텍스트', full)
    return (
      `\n\n...[길어서 여기까지만 전달되었다. 전문은 documentId="${doc.id}"(약 ${doc.tokens.toLocaleString()}토큰)로 보관되어 있다. ` +
      '전체를 대상으로 하는 작업이면 process_document로 나눠 처리하고, 앞부분만으로 충분한 질문이면 그대로 답하라.]'
    )
  }

  if (typeof content === 'string') {
    const NOTE = noteFor(content)
    const room = Math.max(256, budgetTokens - estimateTokens(NOTE))
    return { ...message, content: fitToTokens(content, room) + NOTE }
  }

  const NOTE = '\n\n...[길어서 여기까지만 전달되었다. 받은 부분까지 처리하고 잘렸다는 사실을 알려라.]'
  const room = Math.max(256, budgetTokens - estimateTokens(NOTE))
  if (Array.isArray(content)) {
    // 이미지·PDF 파트는 자를 수 없으니 텍스트 파트만 줄인다
    const texts = content.filter((p: unknown) => (p as { type?: string }).type === 'text')
    if (texts.length === 0) return message
    const share = Math.max(256, Math.floor(room / texts.length))
    const next = content.map((p: unknown) => {
      const part = p as { type?: string; text?: string }
      if (part.type !== 'text' || typeof part.text !== 'string') return p
      if (estimateTokens(part.text) <= share) return p
      return { ...part, text: fitToTokens(part.text, share) + NOTE }
    })
    return { ...message, content: next }
  }
  return message
}

/**
 * 세션당 한 번 띄울 컨텍스트 경고. 설정값과 서버 실측이 어긋난 경우를 먼저 알린다 —
 * 그쪽이 원인이 분명하고 조치도 분명하기 때문이다.
 */
function contextWarning(profile: ModelProfile, historyBudget: number): string | null {
  if (!profile.local) return null
  const { serverContextTokens: server, configuredContextTokens: configured } = profile
  if (server && server !== configured) {
    return (
      `설정에는 ${configured.toLocaleString()}토큰으로 적혀 있지만 Ollama 서버가 실제로 연 창은 ` +
      `${server.toLocaleString()}토큰입니다. 실제 값에 맞춰 동작하지만, 두 값을 맞춰 두는 편이 좋습니다 — ` +
      'Ollama를 완전히 종료했다가 새 터미널에서 다시 띄우면 OLLAMA_CONTEXT_LENGTH가 반영됩니다 ' +
      '(자동 업데이트로 재시작되면 환경 변수를 놓치는 경우가 있습니다).'
    )
  }
  if (historyBudget < 400) {
    return (
      `컨텍스트(${profile.contextTokens.toLocaleString()}토큰)가 좁아 대화 기록을 거의 싣지 못합니다. ` +
      'Ollama라면 OLLAMA_CONTEXT_LENGTH를 올려 서버를 다시 띄우고, ' +
      '설정 > LLM 프로바이더의 "컨텍스트"에 같은 값을 적으세요.'
    )
  }
  return null
}

/** 게이트 도구는 정의에서, 작업 관리 도구는 이름별 규칙으로 요약 */
function summarizeCall(toolName: string, input: unknown): string {
  const def = toolDefByName(toolName)
  if (def) return def.describeCall(input as never)
  const i = (input ?? {}) as Record<string, unknown>
  if (toolName === 'delegate_task') return `작업 위임: ${String(i.title ?? '')}`
  if (toolName === 'cancel_task') return `작업 취소 요청: ${String(i.taskId ?? '')}`
  if (toolName === 'process_document') return `문서 분할 처리: ${String(i.instruction ?? '').slice(0, 40)}`
  if (toolName === 'list_tasks') return '작업 목록 조회'
  if (toolName === 'save_memory') return `기억 저장: ${String(i.title ?? '')}`
  if (toolName === 'schedule_task') return `스케줄 등록: ${String(i.title ?? '')}`
  if (toolName === 'cancel_schedule') return `스케줄 삭제: ${String(i.scheduleId ?? '')}`
  if (toolName === 'list_schedules') return '스케줄 목록 조회'
  if (toolName === 'list_peers') return '피어 에이전트 목록 조회'
  if (toolName === 'ask_peer') return `피어에게 질의: ${String(i.question ?? '').slice(0, 40)}`
  if (toolName === 'delegate_to_peer') return `피어에게 작업 위임: ${String(i.title ?? '')}`
  if (toolName === 'list_secrets') return '시크릿 이름 목록 조회'
  if (toolName === 'request_secret') return `시크릿 입력 요청: ${String(i.name ?? '')}`
  if (toolName === 'list_mcp_servers') return 'MCP 서버 목록 조회'
  if (toolName === 'add_mcp_server') return `MCP 서버 등록: ${String(i.name ?? '')}`
  return toolName
}

/**
 * 경로 비교용 키. 구분자(/ 역슬래시 : 따옴표·백틱)와 대소문자 차이를 지워, 답변에 적힌 경로와
 * 도구가 돌려준 경로를 같은 형태로 놓고 견준다. 경로에 쓰이지 않는 문자는 모두 구분자로 본다.
 */
function pathKey(s: string): string {
  return s
    .toLowerCase()
    .split(/[^a-z0-9._+-]+/)
    .filter(Boolean)
    .join('/')
}

/**
 * 이번 턴에 fs_write로 쓴 파일을 답변이 `출처:`로 인용했는가.
 *
 * 프롬프트로 세 번 막아 봤지만 로컬 9B는 계속 자기가 쓴 파일을 출처로 달았다. 규칙이 잘려서가
 * 아니다 — 창(8192)에 다 들어가는 것을 확인했는데도 따르지 않았다. 모델의 협조를 전제하지 않는
 * 자리는 결과 쪽뿐이라 여기서 본다.
 *
 * 답을 고쳐 쓰지는 않는다. 모델이 한 말은 그대로 두고, 그것이 근거가 아니라는 사실만 덧붙인다.
 */
function citedOwnWrites(items: ChatItem[]): string[] {
  const written = new Map<string, string>()
  for (const it of items) {
    if (it.kind !== 'tool' || it.toolName !== 'fs_write') continue
    if (it.status !== 'done' || !it.output) continue
    try {
      const path = (JSON.parse(it.output) as { path?: unknown }).path
      if (typeof path === 'string') written.set(pathKey(path), path)
    } catch {
      // 결과가 JSON이 아니면(예산에 걸려 요약된 경우 등) 경로를 알 수 없다 — 넘어간다
    }
  }
  if (written.size === 0) return []

  const cited = new Set<string>()
  for (const it of items) {
    if (it.kind !== 'assistant' || !it.text) continue
    for (const line of it.text.split('\n')) {
      if (!line.includes('출처')) continue
      const key = pathKey(line)
      for (const [k, original] of written) if (key.includes(k)) cited.add(original)
    }
  }
  return [...cited]
}

export async function runTurn(
  win: BrowserWindow,
  sessionId: string,
  userText: string,
  attachments: AttachmentPayload[] = []
): Promise<void> {
  const send = (e: ChatEvent): void => {
    if (!win.isDestroyed()) win.webContents.send('chat:event', { sessionId, ...e })
  }

  const session = getSession(sessionId)
  if (!session) {
    send({ type: 'turn-end', error: '세션을 찾을 수 없습니다.', unresolvedToolCallIds: [] })
    return
  }

  const abort = new AbortController()
  activeTurns.set(sessionId, { abort, startedAt: Date.now() })

  const ctx: TurnContext = { sessionId, win, failures: [] }

  // 첨부를 만들기 전에 모델을 확정한다 — 창보다 큰 첨부는 인라인 대신 문서로 보관해야 하고,
  // 그 판단에 예산이 필요하다. 프로바이더 설정 오류는 사용자 메시지를 저장한 뒤에 알린다.
  let resolved: ResolvedModel | null = null
  let resolveError: unknown = null
  try {
    resolved = await resolveModelFor('standard')
  } catch (e) {
    resolveError = e
  }
  const inlineTokenBudget = resolved?.profile.local
    ? Math.max(256, Math.floor(resolved.profile.promptBudget * 0.35))
    : undefined

  const { parts, metas } = await buildAttachmentParts(attachments, { sessionId, inlineTokenBudget })
  const attachNote = metas.length > 0 ? ` [첨부: ${metas.map((m) => m.name).join(', ')}]` : ''

  // 사용자 메시지를 먼저 저장하고, 이후에는 append만 한다
  // (백그라운드 작업이 같은 세션에 동시 기록해도 서로 덮어쓰지 않도록)
  session.items.push({
    kind: 'user',
    text: userText,
    at: new Date().toISOString(),
    ...(metas.length > 0 ? { attachments: metas } : {})
  })
  session.messages.push({
    role: 'user',
    content: parts.length > 0 ? buildUserContent(parts, userText) : userText
  })
  if (!session.meta.titlePinned && session.meta.title === '새 대화') {
    session.meta.title = userText.slice(0, 40)
  }
  saveSession(session)
  const messagesForModel = [...session.messages]

  send({ type: 'turn-start' })

  // 스트림에 나온 순서 그대로 쌓는다. 도구 호출로 끊긴 텍스트는 별개의 블록이 되어야
  // 저장본에서도 "…핵심은 보입니다.잠시만요"처럼 붙어버리지 않는다.
  const newItems: ChatItem[] = []
  const toolItems = new Map<string, ChatItem & { kind: 'tool' }>()
  let textBlock: (ChatItem & { kind: 'assistant' }) | null = null

  const appendText = (delta: string): void => {
    let block = textBlock
    if (!block) {
      block = { kind: 'assistant', text: '', at: new Date().toISOString() }
      textBlock = block
      newItems.push(block)
    }
    block.text += delta
  }

  try {
    // 대화는 도구 호출 품질이 중요하므로 '일반' 등급 사용 (첨부 처리를 위해 위에서 미리 확정)
    if (!resolved) throw resolveError ?? new Error('LLM 프로바이더를 확인할 수 없습니다.')
    const { model, config, profile } = resolved
    ctx.resultChars = profile.toolResultChars

    const tools = {
      ...buildTools(ctx, mainAgentTools(profile)),
      ...(await searchTools(ctx)),
      ...taskTools(win, sessionId),
      ...scheduleTools(sessionId),
      ...memoryTools(win, sessionId),
      ...peerTools(),
      ...integrationTools(win, sessionId),
      ...documentTools(win, sessionId, (documentId, instruction, mode, plan) =>
        startDocumentTask(win, sessionId, documentId, instruction, mode, plan)
      )
    }
    const toolTokens = estimateToolTokens(tools)

    const base = baseSystemPrompt(sessionId, profile)
    // 지식베이스는 남는 예산 안에서만 주입한다. 시스템 프롬프트와 도구 스키마가 먼저이고,
    // 히스토리도 최소 한 턴은 들어가야 하므로 기억에는 그중 일부만 준다.
    const memoryBudget = profile.local
      ? Math.max(0, Math.floor((profile.promptBudget - estimateTokens(base) - toolTokens) * 0.3))
      : undefined
    lastMemoryBudget = memoryBudget
    const memoryContext =
      memoryBudget === 0 ? '' : buildMemoryContext(userText, { budgetTokens: memoryBudget })
    const system = memoryContext ? `${base}\n\n${memoryContext}` : base

    // 남은 예산만큼만 과거 대화를 싣는다 — 넘기면 서버가 앞부분을 조용히 잘라낸다
    const historyBudget = profile.promptBudget - estimateTokens(system) - toolTokens
    const messages = trimHistory(messagesForModel, historyBudget, sessionId)

    // 조용히 잘려 이상한 답이 나오는 것보다, 무엇을 바꿔야 하는지 알리는 편이 낫다.
    const warning = contextWarning(profile, historyBudget)
    if (warning && !contextWarned.has(sessionId)) {
      contextWarned.add(sessionId)
      appendToSession(sessionId, [{ kind: 'notice', text: warning }], [])
      send({ type: 'notice', text: warning })
    }

    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(profile.maxSteps),
      ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      abortSignal: abort.signal
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        appendText(part.text)
        send({ type: 'text-delta', text: part.text })
      } else if (part.type === 'tool-call') {
        const summary = summarizeCall(part.toolName, part.input)
        const item: ChatItem & { kind: 'tool' } = {
          kind: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          summary,
          status: 'running'
        }
        toolItems.set(part.toolCallId, item)
        newItems.push(item)
        textBlock = null
        send({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, summary })
      } else if (part.type === 'tool-result') {
        const output = JSON.stringify(part.output)
        const item = toolItems.get(part.toolCallId)
        const status: 'done' | 'denied' | 'error' = output.includes('"denied":true')
          ? 'denied'
          : output.includes('"error":')
            ? 'error'
            : 'done'
        if (item) {
          item.status = status
          item.output = output.slice(0, 2000)
        }
        send({ type: 'tool-result', toolCallId: part.toolCallId, status, output: output.slice(0, 2000) })
      } else if (part.type === 'tool-error') {
        // 없는 도구 이름이나 스키마에 맞지 않는 인자 — 로컬 모델에서 흔하다.
        // SDK가 오류를 모델에 되돌려 주므로 대화는 이어지지만, 카드를 확정하고
        // 실패 신호를 남기지 않으면 '실행 중'으로 굳어 버린다.
        const message = part.error instanceof Error ? part.error.message : String(part.error)
        const item = toolItems.get(part.toolCallId)
        if (item) {
          item.status = 'error'
          item.output = message.slice(0, 2000)
        }
        ctx.failures.push({ kind: 'tool-error', detail: `${part.toolName} — ${message.slice(0, 200)}` })
        send({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          status: 'error',
          output: message.slice(0, 2000)
        })
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }

    // 히스토리 반영 — 디스크 최신 상태에 append (동시 기록 안전)
    const [response, totalUsage] = await Promise.all([result.response, result.totalUsage])
    // 이 턴 전체(도구 호출 스텝 포함)의 토큰 사용 — 마지막 에이전트 메시지에 귀속시킨다
    const rec = recordUsage(
      { sessionId, kind: 'chat', provider: config.label, model: config.model, tier: 'standard' },
      totalUsage
    )
    const usage = { input: rec.inputTokens, output: rec.outputTokens }
    // 턴 전체의 사용량은 마지막 텍스트 블록에 귀속시킨다 (렌더러가 찾는 위치와 동일)
    for (let i = newItems.length - 1; i >= 0; i--) {
      const it = newItems[i]
      if (it.kind === 'assistant') {
        it.usage = usage
        break
      }
    }
    // 미해결 도구를 저장 전에 확정한다 — 저장 뒤에 고치면 화면만 바뀌고
    // 디스크에는 '실행 중'인 카드가 영구히 남는다
    const unresolvedIds = resolveDanglingTools(toolItems)
    appendToSession(sessionId, newItems, response.messages)
    addSessionUsage(sessionId, usage.input, usage.output)
    send({ type: 'turn-end', unresolvedToolCallIds: unresolvedIds, usage })

    // 자기가 쓴 파일을 출처로 단 경우 — 모델이 규칙을 따르지 않으므로 결과를 보고 사용자에게 알린다
    const selfCited = citedOwnWrites(newItems)
    if (selfCited.length > 0) {
      const text =
        `출처로 적힌 ${selfCited.join(', ')}는 이번 턴에 에이전트가 직접 쓴 파일입니다. ` +
        '확인된 근거가 아니라 방금 작성한 내용이므로, 값이 맞는지는 따로 확인하세요.'
      appendToSession(sessionId, [{ kind: 'notice', text }], [])
      send({ type: 'notice', text })
    }

    // 이번 턴에 바깥을 실제로 관찰한 도구가 있었는가. 없었다면 에이전트가 한 말은 전부
    // 자기 기억에서 나온 것이고, 그것이 지식베이스로 넘어가면 다음 턴에서 근거처럼 되살아난다.
    // 파일을 쓰거나 앱 내부를 조작한 것은 관찰이 아니다 — 제가 쓴 것을 제가 확인했다고 칠 수 없다.
    const verified = newItems.some(
      (it) => it.kind === 'tool' && it.status === 'done' && observesWorld(it.toolName)
    )

    // 백그라운드 기억 추출 — 사용자 응답을 막지 않는다. 실패는 삼키지 않고 화면에 알린다
    void extractMemories(
      sessionId,
      buildTranscript(userText + attachNote, newItems),
      ctx.failures,
      verified
    )
      .then((ops) => {
        if (ops.length > 0) {
          appendToSession(sessionId, [{ kind: 'memory', ops }], [])
          send({ type: 'memory-saved', ops })
        }
      })
      .catch((e: unknown) => {
        const text = `기억 추출 실패: ${describeError(e)}`
        console.error('[memory]', text)
        appendToSession(sessionId, [{ kind: 'notice', text }], [])
        send({ type: 'notice', text })
      })
  } catch (e) {
    const aborted = abort.signal.aborted
    // 오류·중단으로 끝난 턴: 아직 '실행 중'인 도구 카드를 '중단됨'으로 확정한다
    const unresolved = resolveDanglingTools(toolItems)
    appendToSession(sessionId, newItems, [])
    send({
      type: 'turn-end',
      error: aborted ? '사용자가 중지했습니다.' : describeError(e),
      unresolvedToolCallIds: unresolved
    })
  } finally {
    activeTurns.delete(sessionId)
  }
}

/** 기억 추출용 턴 기록 — 화면에 쌓인 순서 그대로 (텍스트/도구가 뒤섞이지 않게) */
function buildTranscript(userText: string, items: ChatItem[]): string {
  const lines = [`사용자: ${userText}`]
  for (const it of items) {
    if (it.kind === 'assistant') {
      lines.push(`에이전트: ${it.text}`)
    } else if (it.kind === 'tool') {
      lines.push(`도구 호출: ${it.summary}`)
      lines.push(`도구 결과(${it.status}): ${(it.output ?? '').slice(0, 500)}`)
    }
  }
  return lines.join('\n')
}

/** '실행 중'에 남은 도구를 '중단됨'으로 바꾸고 그 id 목록을 반환 */
function resolveDanglingTools(toolItems: Map<string, ChatItem & { kind: 'tool' }>): string[] {
  const ids: string[] = []
  for (const item of toolItems.values()) {
    if (item.status === 'running') {
      item.status = 'aborted'
      item.output = item.output ?? '턴이 종료되어 중단되었습니다.'
      ids.push(item.toolCallId)
    }
  }
  return ids
}
