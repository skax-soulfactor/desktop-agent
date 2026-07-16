import { app, Notification, type BrowserWindow } from 'electron'

/** 사용자가 아직 확인하지 않은 알림 수 — 독/작업표시줄 배지에 표시된다 */
let unseenCount = 0
/** focus 리스너를 창마다 한 번만 등록하기 위한 가드 */
const badgeWired = new WeakSet<BrowserWindow>()

function bumpBadge(win: BrowserWindow): void {
  unseenCount++
  // macOS 독 아이콘 배지 (Linux 일부 데스크톱도 지원)
  app.setBadgeCount(unseenCount)
  // Windows는 배지 대신 작업표시줄 깜빡임으로 알린다
  if (process.platform === 'win32') win.flashFrame(true)

  if (!badgeWired.has(win)) {
    badgeWired.add(win)
    // 창을 다시 보면 확인한 것으로 간주하고 배지를 지운다
    win.on('focus', () => {
      unseenCount = 0
      app.setBadgeCount(0)
      if (process.platform === 'win32') win.flashFrame(false)
    })
  }
}

/**
 * 앱이 백그라운드에 있을 때만 OS 알림을 보낸다.
 * 독/작업표시줄 아이콘에 미확인 배지를 함께 표시하고, 창이 포커스되면 지운다.
 * 클릭하면 창을 앞으로 가져온다. 창이 포커스 상태면 이미 보고 있으므로 보내지 않는다.
 */
export function notifyIfBackground(win: BrowserWindow, title: string, body: string): void {
  try {
    if (win.isDestroyed() || win.isFocused()) return
    bumpBadge(win)
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body: body.replace(/\s+/g, ' ').slice(0, 200) })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch (e) {
    // 알림 실패가 본 작업을 막으면 안 된다
    console.error('[notify]', e)
  }
}
