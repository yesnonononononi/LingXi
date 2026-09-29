/** 通用上拉框选项定义 (供 DropUpSelect 等共享组件使用) */
export interface SelectOption<T extends string | number = string> {
  label: string;          // 选项展示文案
  value: T;               // 选项值
  description?: string;   // 选项副标题/说明
  disabled?: boolean;     // 是否禁用该选项
}
