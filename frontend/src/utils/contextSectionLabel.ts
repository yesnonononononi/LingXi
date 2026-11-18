import type {ContextSectionKind} from '../types/Event';
import {t} from '../i18n';

/**
 * 动态段的显示名（卡片与差异预览共用一份）。
 *
 * <p>段种类是后端契约里的枚举，界面不能直接甩 `FORBIDDEN_TOOLS` 给用户看；
 * 但也不能在这里编造新分类 —— 键与 {@link ContextSectionKind} 一一对应，漏一个就编译不过。</p>
 */
const SECTION_LABEL_KEYS: Record<ContextSectionKind, string> = {
  MCP: 'chat.contextFact.sectionMcp',
  SKILL: 'chat.contextFact.sectionSkill',
  MEMORY: 'chat.contextFact.sectionMemory',
  WORK_DIR: 'chat.contextFact.sectionWorkDir',
  PERMISSION: 'chat.contextFact.sectionPermission',
  ENVIRONMENT: 'chat.contextFact.sectionEnvironment',
  FORBIDDEN_TOOLS: 'chat.contextFact.sectionForbiddenTools',
  TASK: 'chat.contextFact.sectionTask',
};

/** 段种类的界面名；未知取值原样显示（后端加段时界面不崩，也不假装认识）。 */
export function contextSectionLabel(kind: ContextSectionKind | string): string {
  const key = SECTION_LABEL_KEYS[kind as ContextSectionKind];
  return key ? t(key) : String(kind);
}
