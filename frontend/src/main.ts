import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureMuckMigrated } from '@/api/muck-service'
import './styles/global.css'

// 启动时先把存量运输单按外运日期迁移补录，各模块读到的就是同一份干净台账
ensureMuckMigrated()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
