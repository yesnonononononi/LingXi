import {createApp} from 'vue';
import {createPinia} from 'pinia';
import './style.css';
import App from './App.vue';
import router from './services/router';
import {useBackgroundPreference} from './composables/useBackgroundPreference';
import {initPackHost} from './packs/packHost';

// 启动即恢复主页背景与官方扩展包偏好（失败静默回落默认外观，不阻塞首屏启动）。
void useBackgroundPreference().init();
void initPackHost();

const app = createApp(App);
// pinia 先于 router 注册：路由守卫与视图组件都可能在建流前读到 store。
app.use(createPinia());
app.use(router);
app.mount('#app');
