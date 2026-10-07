import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import router from './services/router';

const app = createApp(App);
// pinia 先于 router 注册：路由守卫与视图组件都可能在建流前读到 store。
app.use(createPinia());
app.use(router);
app.mount('#app');
