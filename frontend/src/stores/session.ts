import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '调度',
    fleet: '渣土一队',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isDispatcher: (state) => state.role === '调度',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setIdentity(role: string, fleet: string) {
      this.role = role
      this.fleet = fleet
    },
  },
})
