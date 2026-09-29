import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import router from './services/router';

const app = createApp(App);
// pinia 先于 router 注册：路由守卫与视图组件都可能在建流前读到 store
// （见 stores/sseRouter.ts —— SSE 连接归属收在 store 里，不再由组件持有）。
app.use(createPinia());
app.use(router);
app.mount('#app');
