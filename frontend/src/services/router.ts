import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

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

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
