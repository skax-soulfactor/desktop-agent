import { useEffect, useRef } from 'react'
import type { SidebarSide } from '../lib/sidebarPrefs'
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH } from '../lib/sidebarPrefs'

interface Props {
  width: number
  side: SidebarSide
  onResize: (w: number) => void
  onCommit: () => void
  onReset: () => void
}

/**
 * 사이드바 폭 드래그 핸들.
 * 사이드바가 오른쪽에 있으면 커서를 왼쪽으로 끌어야 넓어지므로 방향을 뒤집는다.
 */
export default function SidebarResizer({
  width,
  side,
  onResize,
  onCommit,
  onReset
}: Props): JSX.Element {
  /** 드래그 시작 시점의 커서 x와 폭. 진행 중 폭 변화에 델타가 누적되지 않도록 고정한다 */
  const origin = useRef<{ x: number; width: number } | null>(null)
  const dirRef = useRef(1)
  dirRef.current = side === 'left' ? 1 : -1

  // 포인터가 사이드바 밖으로 나가도 계속 따라오도록 window에 건다
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const o = origin.current
      if (!o) return
      onResize(o.width + dirRef.current * (e.clientX - o.x))
    }
    const up = (): void => {
      if (!origin.current) return
      origin.current = null
      document.body.classList.remove('resizing')
      onCommit()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [onResize, onCommit])

  const start = (e: React.MouseEvent): void => {
    e.preventDefault()
    origin.current = { x: e.clientX, width }
    document.body.classList.add('resizing')
  }

  // 드래그는 포인터 정밀도를 요구하므로 키보드 경로도 둔다
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 32 : 8
    if (e.key === 'ArrowLeft') onResize(width - dirRef.current * step)
    else if (e.key === 'ArrowRight') onResize(width + dirRef.current * step)
    else if (e.key === 'Home') {
      onReset()
      e.preventDefault()
      return
    } else return
    onCommit()
    e.preventDefault()
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="사이드바 폭 조절"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      title={`드래그해서 폭 조절 · 더블클릭하면 기본값(${DEFAULT_WIDTH}px)`}
      onMouseDown={start}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  )
}
