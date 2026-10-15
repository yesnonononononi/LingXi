/** 通用上拉框选项定义 (供 DropUpSelect 等共享组件使用) */
export interface SelectOption<T extends string | number = string> {
  label: string;          // 选项展示文案
  value: T;               // 选项值
  description?: string;   // 选项副标题/说明
  /** 头像（Emoji 或图片 URL），可空；URL 渲染为小图，其余按 Emoji 文本渲染 */
  avatar?: string;
  disabled?: boolean;     // 是否禁用该选项
}
