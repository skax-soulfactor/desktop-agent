import { z } from 'zod'
import type { RiskLevel } from '@shared/types'

export interface DesktopToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  risk: RiskLevel
  inputSchema: S
  /** 승인 다이얼로그에 보여줄 사람이 읽을 수 있는 요약 */
  describeCall(input: z.infer<S>): string
  /** 권한 규칙 매칭 대상 (파일 경로 또는 명령 문자열) */
  targetOf(input: z.infer<S>): string
  /** "항상 허용" 선택 시 제안할 기본 패턴 */
  suggestedPattern(input: z.infer<S>): string
  /**
   * 상승 실행 도구만 구현한다 — 승인 화면에 실제로 root로 넘어갈 인자를 그대로 보여주기 위한 것.
   * 화면의 한 줄이 실행되는 인자 하나와 1:1로 대응해야 사용자가 판단할 수 있다.
   */
  argvOf?(input: z.infer<S>): string[]
  execute(input: z.infer<S>): Promise<unknown>
}
