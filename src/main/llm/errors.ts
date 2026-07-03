/** API 오류를 사용자가 조치할 수 있는 메시지로 변환 */
export function describeError(e: unknown): string {
  const err = e as { message?: string; statusCode?: number; url?: string; responseBody?: string }
  const status = err.statusCode
  if (status === 404) {
    return (
      `LLM API 404 (Not Found): 모델 ID 또는 Base URL이 잘못되었을 가능성이 큽니다. ` +
      `설정에서 확인하세요. (요청 주소: ${err.url ?? '알 수 없음'})`
    )
  }
  if (status === 401 || status === 403) {
    return `LLM API 인증 실패 (${status}): API 키를 확인하세요.`
  }
  if (status === 429) {
    return 'LLM API 사용량 한도 초과 (429): 잠시 후 다시 시도하세요.'
  }
  const detail = err.responseBody ? ` — ${String(err.responseBody).slice(0, 300)}` : ''
  return (err.message ?? String(e)) + detail
}
