/// <reference types="vite/client" />
import type { DesktopAgentApi } from '@shared/api'

declare global {
  interface Window {
    api: DesktopAgentApi
  }
}

export {}
