import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { startScheduler } from './agent/scheduler'
import { initNetwork } from './network/manager'
import { closeAllMcpConnections } from './mcp/manager'
import { initUpdater } from './update'

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
  startScheduler(() => mainWindow)
  void initNetwork(() => mainWindow)
  // 자동 업데이트: 이벤트를 렌더러로 연결하고, 패키징된 빌드에서는 주기적으로 확인한다
  // (수동 확인·설치는 설정 화면의 update:* IPC로 처리)
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
