import { useCallback, useRef, useState } from 'react'

export type SidebarSide = 'left' | 'right'

export interface SidebarPrefs {
  width: number
  hidden: boolean
  side: SidebarSide
}

const KEY = 'sidebar.prefs'

export const DEFAULT_WIDTH = 244
export const MIN_WIDTH = 180
export const MAX_WIDTH = 520

export function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))
}

const DEFAULTS: SidebarPrefs = { width: DEFAULT_WIDTH, hidden: false, side: 'left' }

function load(): SidebarPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>
    return {
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : DEFAULT_WIDTH),
      hidden: parsed.hidden === true,
      side: parsed.side === 'right' ? 'right' : 'left'
    }
  } catch {
    return DEFAULTS
  }
}

export interface SidebarControls {
  prefs: SidebarPrefs
  /** 드래그 중 호출 — 화면만 갱신하고 저장은 commitWidth에서 한다 */
  setWidth: (w: number) => void
  /** 드래그가 끝난 시점에 한 번만 저장 */
  commitWidth: () => void
  resetWidth: () => void
  toggleHidden: () => void
  toggleSide: () => void
}

/**
 * 사이드바 폭·표시 여부·좌우 위치. localStorage에 보관해 앱을 다시 열어도 유지된다.
 * 폭은 드래그 중 매 프레임 저장하면 낭비이므로 커밋 시점을 분리했다.
 */
export function useSidebarPrefs(): SidebarControls {
  const [prefs, setPrefs] = useState<SidebarPrefs>(load)
  const latest = useRef(prefs)
  latest.current = prefs

  const persist = useCallback((next: SidebarPrefs): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // 저장이 막혀 있어도 이번 세션 동작은 계속되어야 한다
    }
  }, [])

  const setWidth = useCallback((w: number): void => {
    setPrefs((p) => ({ ...p, width: clampWidth(w) }))
  }, [])

  const commitWidth = useCallback((): void => persist(latest.current), [persist])

  const update = useCallback(
    (patch: Partial<SidebarPrefs>): void => {
      setPrefs((p) => {
        const next = { ...p, ...patch }
        persist(next)
        return next
      })
    },
    [persist]
  )

  return {
    prefs,
    setWidth,
    commitWidth,
    resetWidth: () => update({ width: DEFAULT_WIDTH }),
    toggleHidden: () => update({ hidden: !latest.current.hidden }),
    toggleSide: () => update({ side: latest.current.side === 'left' ? 'right' : 'left' })
  }
}
