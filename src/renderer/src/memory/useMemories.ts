import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry, MemoryReviewItem, MemoryStats } from '@shared/types'

export interface MemoryData {
  entries: MemoryEntry[]
  stats: MemoryStats | null
  review: MemoryReviewItem[]
  loading: boolean
  refresh: () => Promise<void>
}

/**
 * 지식베이스 로드 훅.
 * 목록·요약·점검 대기함을 한 번에 갱신한다 — 편집 한 번이 세 가지 모두를 바꾸기 때문이다.
 */
export function useMemories(): MemoryData {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [review, setReview] = useState<MemoryReviewItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    const [e, s, r] = await Promise.all([
      window.api.listMemories(),
      window.api.memoryStats(),
      window.api.memoryReview()
    ])
    setEntries(e)
    setStats(s)
    setReview(r)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { entries, stats, review, loading, refresh }
}

export const TYPE_LABEL = {
  user: '사용자',
  requirement: '요구사항',
  lesson: '교훈',
  reference: '참조'
} as const

export const NO_SHARE_TAG = '공유제외'

/** "3일 전" 형태의 상대 시간. 값이 없으면 회상된 적 없음 */
export function relativeTime(iso?: string): string {
  if (!iso) return '—'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return '오늘'
  if (days === 1) return '어제'
  if (days < 30) return `${days}일 전`
  if (days < 365) return `${Math.floor(days / 30)}개월 전`
  return `${Math.floor(days / 365)}년 전`
}
