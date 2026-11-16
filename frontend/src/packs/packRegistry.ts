import type {OfficialPackCategory, OfficialPackEntry} from './types';

/**
 * 内置官方扩展包清单：
 * 按 category 分类注册，不同分类可同时叠加激活，未启用时不会加载包体 chunk。
 */
export const OFFICIAL_PACKS: readonly OfficialPackEntry[] = Object.freeze([
  {
    meta: {
      id: 'obsidian-editorial',
      category: 'theme',
      name: '曜石编辑风',
      description: '暖金强调色与深邃炭黑/羊皮纸双态配色，统一调整侧边栏与输入区表面质感。',
      version: '1.0.0',
      capabilities: ['明暗配色', '表面质感'],
      preview: {
        canvas: '#0b0a09',
        surface: '#141210',
        accent: '#d4a359',
        text: '#f4f4f5',
      },
    },
    load: async () => {
      const mod = await import('./builtin/obsidianEditorial');
      return mod.obsidianEditorialPack;
    },
  },
  {
    meta: {
      id: 'editorial-serif-font',
      category: 'font',
      name: '书卷衬线体',
      description: '正文字体切换为衬线阅读栈，代码块搭配清晰等宽字体，适合长文阅读与写作。',
      version: '1.0.0',
      capabilities: ['正文字体', '代码字体'],
      fontPreview: {
        sample: 'Aa 永字八法 · code()',
        family: "'Georgia', 'Noto Serif SC', serif",
      },
    },
    load: async () => {
      const mod = await import('./builtin/editorialSerifFont');
      return mod.editorialSerifFontPack;
    },
  },
  {
    meta: {
      id: 'aurora-glass',
      category: 'background',
      name: '极光氛围背景',
      description: '替换主页背景表面为极光渐变光斑，营造柔和通透的视觉氛围。',
      version: '1.0.0',
      capabilities: ['背景 Slot', '环境光晕'],
      preview: {
        canvas: '#04090b',
        surface: '#0b161c',
        accent: '#14b8a6',
        text: '#f4f4f5',
      },
    },
    load: async () => {
      const mod = await import('./builtin/auroraGlass');
      return mod.auroraGlassPack;
    },
  },
  {
    meta: {
      id: 'floating-sidebar',
      category: 'sidebar',
      name: '悬浮玻璃侧边栏',
      description: '将侧边栏改造为圆角悬浮毛玻璃卡片，并升级底部设置入口为胶囊指示样式。',
      version: '1.0.0',
      capabilities: ['侧边栏底栏 Slot', '悬浮毛玻璃'],
    },
    load: async () => {
      const mod = await import('./builtin/floatingSidebar');
      return mod.floatingSidebarPack;
    },
  },
  {
    meta: {
      id: 'glass-input',
      category: 'input',
      name: '流光玻璃输入栏',
      description: '输入卡片改为半透明毛玻璃容器 + 聚焦流光边框，并替换为胶囊上下文用量徽标。',
      version: '1.0.0',
      capabilities: ['上下文 Slot', '毛玻璃输入栏'],
    },
    load: async () => {
      const mod = await import('./builtin/glassInput');
      return mod.glassInputPack;
    },
  },
  {
    meta: {
      id: 'pulse-stream',
      category: 'component',
      name: '流式脉冲套件',
      description: '替换输入区发送按钮为极简胶囊样式，并优化流式文本渐显与思维链呼吸节奏。',
      version: '1.0.0',
      capabilities: ['发送按钮 Slot', '流式动效'],
    },
    load: async () => {
      const mod = await import('./builtin/pulseStream');
      return mod.pulseStreamPack;
    },
  },
]);

/** 按 id 查找内置扩展包；找不到返回 undefined。 */
export function findOfficialPack(packId: string): OfficialPackEntry | undefined {
  return OFFICIAL_PACKS.find(entry => entry.meta.id === packId);
}

/** 按分类过滤官方扩展包列表。 */
export function listOfficialPacksByCategory(category: OfficialPackCategory): readonly OfficialPackEntry[] {
  return OFFICIAL_PACKS.filter(entry => entry.meta.category === category);
}
