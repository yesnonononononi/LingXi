/** 通用上拉框选项定义 (供 DropUpSelect 等共享组件使用) */
export interface SelectOption<T extends string | number = string> {
  label: string;          // 选项展示文案
  value: T;               // 选项值
  description?: string;   // 选项副标题/说明
  /** 头像（Emoji 或图片 URL），可空；URL 渲染为小图，其余按 Emoji 文本渲染 */
  avatar?: string;
  disabled?: boolean;     // 是否禁用该选项
  /** 分组名：相同分组的选项连续排列，并在组首渲染标题（未设置则不分组） */
  group?: string;
  /** 分组图标（内置提供商图标 key / emoji / 图片 URL） */
  groupIcon?: string;
  /** 分组右上角数量徽标；缺省显示该组当前可见选项数 */
  groupCount?: number;
}
