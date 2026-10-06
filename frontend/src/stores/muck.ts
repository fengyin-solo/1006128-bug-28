import { defineStore } from 'pinia'

import type { MuckFilters } from '@/domain/muck'

/**
 * 渣土外运的筛选与分页状态只有这一份：
 * 查询、翻页、统计都从这里读，换页、切菜单再回来条件都还在。
 */
export const useMuckStore = defineStore('muck', {
  state: () => ({
    filters: { 消纳场所: '', 运输车辆: '', 外运时段: '' } as Record<keyof MuckFilters, string>,
    page: 1,
    pageSize: 5,
  }),
  actions: {
    applyFilters(next: Record<keyof MuckFilters, string>) {
      this.filters = { ...next }
      this.page = 1
    },
    resetFilters() {
      this.filters = { 消纳场所: '', 运输车辆: '', 外运时段: '' }
      this.page = 1
    },
    setPage(page: number) {
      this.page = page
    },
  },
})
