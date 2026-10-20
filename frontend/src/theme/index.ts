/**
 * 主题层 barrel：组件一律从 `@/theme` 或 `../../theme` 引入，不直接摸内部文件名，
 * 这样后续把 token 改成运行时注入时，引用点不用动。
 */
export * from './tokens';
export * from './mapping';
