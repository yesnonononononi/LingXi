import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

const routes: Array<RouteRecordRaw> = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/chat/ChatView.vue'),
    meta: { requiresAuth: true },
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

// 全局路由守卫：认证与拦截控制
router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('token');
  const requiresAuth = to.meta.requiresAuth !== false;

  if (requiresAuth && !token) {
    // 未登录访问受保护页面，重定向至登录页
    next({ name: 'Login' });
  } else if (to.name === 'Login' && token) {
    // 已登录访问登录页，重定向至首页
    next({ name: 'Home' });
  } else {
    next();
  }
});

export default router;
