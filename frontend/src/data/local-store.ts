import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  replaceRowsAtomic(key, rows)
}

/**
 * 原子落库：先写 localStorage，写成功了才更新内存缓存。
 * 落库抛错时内存保持原样，调用方拿到异常即可保证「整套撤回」，不会留下半套数据。
 */
export function replaceRowsAtomic(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先落库：setItem 抛错（配额满 / 存储故障）时直接向外抛，缓存保持原样，整套撤回。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

/** 重新从存储装载（供取数失败后的重试使用，避免沿用上一轮的内存结果）。 */
export function reloadStorage(): Record<string, EntryRow[]> {
  cache = readStorage()
  return cache
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
