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
  execute(input: z.infer<S>): Promise<unknown>
}
