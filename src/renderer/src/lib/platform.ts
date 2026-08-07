/** mac/win에서만 OS 알림 설정 화면을 열 수 있다 (Linux는 데스크톱마다 달라 생략) */
export const canOpenNotificationSettings =
  navigator.userAgent.includes('Macintosh') || navigator.userAgent.includes('Windows')
