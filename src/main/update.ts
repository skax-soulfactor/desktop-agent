import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

let wired = false
let getWin: (() => BrowserWindow | null) | null = null
let lastStatus: UpdateStatus = { state: 'idle' }

function emit(status: UpdateStatus): void {
  lastStatus = status
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
}

/** autoUpdater 이벤트를 한 번만 렌더러 상태로 연결한다 */
function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () =>
    emit({ state: 'not-available', version: app.getVersion() })
  )
  autoUpdater.on('download-progress', (p) =>
    emit({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) =>
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  )
}

/** 앱 시작 시 호출 — 이벤트를 연결하고, 패키징된 빌드에서는 주기적으로 확인한다 */
export function initUpdater(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter
  wire()
  if (app.isPackaged) {
    const check = (): void => {
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        emit({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    }
    check()
    setInterval(check, 4 * 60 * 60 * 1000)
  }
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

/** 사용자가 설정 화면에서 직접 업데이트를 확인 */
export async function checkForUpdatesManual(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    // 개발 모드에는 업데이트 소스(GitHub Releases 메타)가 없어 확인이 불가능하다
    const s: UpdateStatus = {
      state: 'unsupported',
      message: '개발 모드에서는 업데이트를 확인할 수 없습니다. 설치된 앱에서 사용하세요.'
    }
    emit(s)
    return s
  }
  emit({ state: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
    return lastStatus
  } catch (err) {
    const s: UpdateStatus = {
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    }
    emit(s)
    return s
  }
}

/** 다운로드된 업데이트를 설치하며 앱 재시작 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
