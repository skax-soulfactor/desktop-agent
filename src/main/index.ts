import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { startScheduler } from './agent/scheduler'
import { initNetwork } from './network/manager'
import { closeAllMcpConnections } from './mcp/manager'
import { initUpdater } from './update'
import { refreshBadge } from './notify'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 560,
    title: 'Desktop Agent',
    // 흰색 플래시 방지 + 타이틀바를 앱 배경과 통합 (드래그는 .topnav의 app-region이 담당)
    backgroundColor: '#1f1e1d',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          // Windows/Linux: 창 조작 버튼만 오버레이로 남기고 나머지는 앱이 그린다
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#1f1e1d', symbolColor: '#eceae4', height: 40 },
          autoHideMenuBar: true,
          // macOS는 .icns가 Dock을 담당하고, Windows/Linux는 창 아이콘을 직접 지정한다
          icon
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 시스템 다크 외관 강제 — 네이티브 메뉴·다이얼로그도 앱과 톤을 맞춘다
  nativeTheme.themeSource = 'dark'
  // Windows 알림(Notification)은 AppUserModelID가 있어야 표시된다
  if (process.platform === 'win32') app.setAppUserModelId('com.desktop-agent.app')
  registerIpc(() => {
    if (!mainWindow) throw new Error('window not ready')
    return mainWindow
  })
  createWindow()
  // 지난 실행에서 확인하지 않은 알림이 있으면 배지를 복원한다
  refreshBadge()
  startScheduler(() => mainWindow)
  void initNetwork(() => mainWindow)
  // 업데이트: 새 버전 유무만 자동으로 확인해 렌더러에 알린다.
  // 내려받기·설치는 항상 사용자가 배너나 설정 화면에서 직접 선택한다 (update:* IPC)
  initUpdater(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  void closeAllMcpConnections()
})
