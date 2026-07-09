/** API 오류를 사용자가 조치할 수 있는 메시지로 변환 */
export function describeError(e: unknown): string {
  const err = e as { message?: string; statusCode?: number; url?: string; responseBody?: string }
  const status = err.statusCode
  if (status === 404) {
    const body = err.responseBody ? ` 서버 응답: ${String(err.responseBody).slice(0, 300)}` : ''
    return (
      `LLM API 404 (Not Found): 모델 ID·Base URL이 잘못되었거나, ` +
      `모델이 요청한 입력(이미지·PDF 첨부 등)을 지원하지 않는 경우입니다. ` +
      `이미지·PDF를 보냈다면 설정에서 비전(이미지 입력) 지원 모델로 바꾸세요.` +
      body
    )
  }
  if (status === 401 || status === 403) {
    return `LLM API 인증 실패 (${status}): API 키를 확인하세요.`
  }
  if (status === 429) {
    return 'LLM API 사용량 한도 초과 (429): 잠시 후 다시 시도하세요.'
  }
  const code = (e as { cause?: { code?: string } }).cause?.code
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return (
      'LLM API TLS 인증서 검증 실패: 회사망 SSL 검사(프록시) 환경일 수 있습니다. ' +
      '앱을 최신 버전으로 업데이트했는지 확인하거나 IT에 openrouter.ai 허용을 요청하세요.'
    )
  }
  const detail = err.responseBody ? ` — ${String(err.responseBody).slice(0, 300)}` : ''
  return (err.message ?? String(e)) + detail
}
