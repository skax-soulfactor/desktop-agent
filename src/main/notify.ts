import { app, Notification, type BrowserWindow } from 'electron'
import type { NotificationKind, NotificationRecord } from '@shared/types'
import { addNotification, unreadCount } from './notifications/store'

/** 작업표시줄 깜빡임 해제 리스너를 창마다 한 번만 등록하기 위한 가드 */
const flashWired = new WeakSet<BrowserWindow>()

/** 독/작업표시줄 배지를 미확인 알림 수에 맞춘다 (알림 화면에서 확인하면 0이 된다) */
export function refreshBadge(): void {
  try {
    app.setBadgeCount(unreadCount())
  } catch (e) {
    console.error('[notify] 배지 갱신 실패:', e)
  }
}

function flash(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  win.flashFrame(true)
  if (!flashWired.has(win)) {
    flashWired.add(win)
    win.on('focus', () => win.flashFrame(false))
  }
}

/**
 * 알림 1건을 기록하고, 앱이 백그라운드에 있을 때만 OS 알림을 띄운다.
 *
 * OS 알림이 꺼져 있거나 창을 보고 있어서 표시되지 않은 건도 기록에는 남으므로,
 * 알림 화면에서 지난 내역을 다시 확인할 수 있다.
 * 미확인 건수는 독/작업표시줄 배지로 표시되고, 알림 화면에서 확인하면 사라진다.
 * OS 알림을 클릭하면 창을 앞으로 가져온다.
 */
export function notifyIfBackground(
  win: BrowserWindow,
  title: string,
  body: string,
  meta: { kind: NotificationKind; sessionId?: string } = { kind: 'system' }
): void {
  const text = body.replace(/\s+/g, ' ').trim()
  const alive = !win.isDestroyed()
  // 창이 포커스 상태면 사용자가 이미 보고 있으므로 OS 알림은 띄우지 않는다
  const deliver = alive && !win.isFocused() && Notification.isSupported()

  let rec: NotificationRecord | null = null
  try {
    rec = addNotification({
      kind: meta.kind,
      title,
      body: text.slice(0, 500),
      delivered: deliver,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {})
    })
  } catch (e) {
    console.error('[notify] 기록 실패:', e)
  }

  if (!alive) return
  try {
    refreshBadge()
    if (rec) win.webContents.send('notifications:changed')
    if (!deliver) return
    flash(win)
    const n = new Notification({ title, body: text.slice(0, 200) })
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
