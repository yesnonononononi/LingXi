import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import router from './services/router';
import { useBackgroundPreference } from './composables/useBackgroundPreference';

// 启动即恢复主页背景偏好（有偏好 → 读本机图片并写文档根变量；无偏好 → 一个变量都不写）。
// 刻意放这里而不是 App.vue 的 onMounted：它必须在首屏渲染前就开始，且失败要静默回落（不阻塞启动）。
void useBackgroundPreference().init();

const app = createApp(App);
// pinia 先于 router 注册：路由守卫与视图组件都可能在建流前读到 store。
app.use(createPinia());
app.use(router);
app.mount('#app');
