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

/** 진행 중인 확인·다운로드가 있으면 새 요청을 무시한다 */
function busy(): boolean {
  return lastStatus.state === 'checking' || lastStatus.state === 'downloading'
}

/** autoUpdater 이벤트를 한 번만 렌더러 상태로 연결한다 */
function wire(): void {
  if (wired) return
  wired = true
  // 확인만 자동으로 하고, 내려받기와 설치는 사용자가 직접 결정한다
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
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

/** 앱 시작 시 호출 — 이벤트를 연결하고, 패키징된 빌드에서는 주기적으로 새 버전 유무만 확인한다 */
export function initUpdater(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter
  wire()
  if (app.isPackaged) {
    const check = (): void => {
      // 사용자가 이미 내려받는 중이거나 설치를 기다리는 중이면 건드리지 않는다
      if (busy() || lastStatus.state === 'downloaded') return
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

/** 새 버전 유무만 확인한다 — 내려받기는 시작하지 않는다 */
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
  if (busy()) return lastStatus
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

/** 사용자가 업데이트를 선택했을 때만 내려받는다 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    const s: UpdateStatus = {
      state: 'unsupported',
      message: '개발 모드에서는 업데이트를 내려받을 수 없습니다. 설치된 앱에서 사용하세요.'
    }
    emit(s)
    return s
  }
  if (busy() || lastStatus.state === 'downloaded') return lastStatus
  emit({ state: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
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
