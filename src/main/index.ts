import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { startScheduler } from './agent/scheduler'
import { initNetwork } from './network/manager'
import { closeAllMcpConnections } from './mcp/manager'

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
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#1f1e1d', symbolColor: '#eceae4', height: 40 }
          }
        : {}),
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
