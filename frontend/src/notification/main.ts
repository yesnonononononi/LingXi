/**
 * 自绘通知窗口的渲染入口。
 *
 * <p>刻意不引 Vue：这个窗口的生命周期只有几秒、DOM 结构就一张卡片，
 * 装一整套框架只为了渲染两行文字不划算，而且独立入口能把 Vue 运行时挡在
 * 通知窗口的启动路径之外（首帧更快，材质动画更跟手）。</p>
 *
 * <p>文案由主进程转交给这里，<b>不做任何 i18n 解析</b> —— 语言状态住在主应用的
 * 渲染进程里，通知窗口另起一份 i18n 实例必然与其漂移。</p>
 */
import './notification.css';

/** 通知类别：决定图标与配色。 */
type NotifyKind = 'completed' | 'failed' | 'cancelled' | 'suspended';

/** 主进程推来的通知数据（与 `notification-window.cjs` 的 payload 一一对应）。 */
interface NotificationData {
  id: number;
  title?: string;
  body?: string;
  kind?: NotifyKind;
  /** 主应用当前主题；缺省时回退到 localStorage。 */
  theme?: 'dark' | 'light';
  duration?: number;
}

interface NotificationBridge {
  onData: (callback: (data: NotificationData) => void) => () => void;
  setHover: (hovered: boolean) => Promise<boolean>;
  activate: () => Promise<boolean>;
  dismiss: () => Promise<boolean>;
}

declare global {
  interface Window {
    notificationAPI?: NotificationBridge;
  }
}

/** 每类通知的图标字形；用文字而不是 SVG，省掉一份资源也够用。 */
const GLYPHS: Record<NotifyKind, string> = {
  completed: '\u2713',
  failed: '!',
  cancelled: '\u00d7',
  suspended: '!',
};

const KNOWN_KINDS: readonly NotifyKind[] = ['completed', 'failed', 'cancelled', 'suspended'];

/** 主应用主题存在这个 key 下（与 `index.html` 的首屏脚本共用同一份来源）。 */
const THEME_STORAGE_KEY = 'lingxi-theme';

/** 通知窗口与主应用同源（无论是 Vite 还是 file://），所以能直接读到主题偏好。 */
function applyTheme(root: HTMLElement, preferred?: 'dark' | 'light'): void {
  // 主应用直接传过来的主题优先：打包后通知窗口是 file:// 源，
  // 与主应用的 localStorage 未必共用，靠读存储会漂移。
  if (preferred === 'dark' || preferred === 'light') {
    root.classList.toggle('theme-light', preferred === 'light');
    return;
  }
  let light = false;
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    light = saved ? saved === 'light' : false;
  } catch {
    // 存储不可用（隐私模式 / 异常 profile）时按暗色渲染：主应用默认也是暗色
  }
  root.classList.toggle('theme-light', light);
}

/** 让文本安全地进 DOM：这里全程用 textContent，绝不拼 innerHTML。 */
function text(tag: string, className: string, value: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function normalizeKind(value: unknown): NotifyKind {
  return KNOWN_KINDS.includes(value as NotifyKind) ? (value as NotifyKind) : 'completed';
}

function render(data: NotificationData): void {
  const root = document.getElementById('notification-root');
  if (!root) return;

  const kind = normalizeKind(data.kind);

  const html = document.documentElement;
  applyTheme(html, data.theme);

  const card = document.createElement('div');
  card.className = `card is-${kind}`;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  const icon = text('span', 'icon', GLYPHS[kind]);
  icon.setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  content.className = 'content';
  content.appendChild(text('div', 'title', data.title || 'LX'));
  if (data.body) content.appendChild(text('div', 'body', data.body));

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '\u00d7';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', (event) => {
    // 关闭按钮不能顺带触发「点击卡片跳转」
    event.stopPropagation();
    void window.notificationAPI?.dismiss();
  });

  card.append(icon, content, close);
  root.replaceChildren(card);

  // 入场动画：先挂一帧再切 class，否则 transition 不会触发
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.add('entered'));
  });

  card.addEventListener('click', () => { void window.notificationAPI?.activate(); });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void window.notificationAPI?.activate();
    }
  });

  // 悬停暂停倒计时：用户把鼠标移过来通常就是在读，这时候消失是最恼人的行为
  card.addEventListener('mouseenter', () => { void window.notificationAPI?.setHover(true); });
  card.addEventListener('mouseleave', () => { void window.notificationAPI?.setHover(false); });
}

function boot(): void {
  const api = window.notificationAPI;
  if (!api) return;
  // 只消费第一条：一个窗口只承载一条通知，主进程为每条通知各建一个窗口
  let consumed = false;
  api.onData((data) => {
    if (consumed) return;
    consumed = true;
    render(data);
  });
}

boot();
  
