import { createRouter, createWebHistory, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { isElectron } from '../utils/platform';

// 本地单实例（HC-1）：无账号体系，路由即页面，无守卫。
const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/chat/ChatView.vue'),
  },
  {
    path: '/models',
    name: 'Models',
    component: () => import('../views/model/ModelListView.vue'),
  },
  {
    path: '/models/new',
    name: 'ModelNew',
    component: () => import('../views/model/ModelFormView.vue'),
  },
  {
    path: '/models/:id/edit',
    name: 'ModelEdit',
    component: () => import('../views/model/ModelFormView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

// 桌面客户端 (Electron file:// 协议) 使用 Hash 路由避免刷新 404；Web 端保留标准 History 模式
const router = createRouter({
  history: isElectron() ? createWebHashHistory() : createWebHistory(),
  routes,
});

export default router;
