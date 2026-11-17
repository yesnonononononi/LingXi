import type {OfficialPackDefinition} from '../types';

/** 外部纯 CSS 极限示例（任务清单）：无需替换 Vue 组件，仅靠 cssText 实现手账方格纸与编号印章效果。 */
export const amberCraftChecklistPack: OfficialPackDefinition = {
  id: 'amber-craft-checklist',
  cssText: `
@keyframes lx-ledger-highlight {
  0%, 100% { box-shadow: inset 3px 0 0 #d97706, 0 2px 10px -4px rgba(217, 119, 6, 0.25); }
  50% { box-shadow: inset 4px 0 0 #f59e0b, 0 4px 16px -4px rgba(245, 158, 11, 0.4); }
}
.task-progress-surface .checklist-tasks [data-testid="checklist-toggle"] {
  border-radius: 8px 14px 14px 8px !important;
  border: 1px dashed rgba(217, 119, 6, 0.55) !important;
  border-left: 4px solid #d97706 !important;
  background: linear-gradient(135deg, #fffbeb, #fef3c7) !important;
  color: #78350f !important;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 3px 10px -3px rgba(180, 83, 9, 0.22) !important;
}
.task-progress-surface[data-theme='dark'] .checklist-tasks [data-testid="checklist-toggle"] {
  border-color: rgba(251, 191, 36, 0.45) !important;
  border-left-color: #f59e0b !important;
  background: linear-gradient(135deg, rgba(41, 24, 9, 0.94), rgba(28, 18, 8, 0.94)) !important;
  color: #fde68a !important;
}
.task-progress-surface .checklist-tasks [data-testid="checklist-panel"] {
  position: relative;
  border-radius: 14px !important;
  border: 1px solid rgba(217, 119, 6, 0.38) !important;
  background-color: #fffdf7 !important;
  background-image:
    linear-gradient(90deg, transparent 34px, rgba(244, 63, 94, 0.2) 34px, rgba(244, 63, 94, 0.2) 35px, transparent 35px),
    repeating-linear-gradient(180deg, transparent 0, transparent 27px, rgba(217, 119, 6, 0.08) 27px, rgba(217, 119, 6, 0.08) 28px) !important;
  color: #451a03 !important;
  padding-left: 46px !important;
  box-shadow: 0 18px 40px -12px rgba(146, 64, 14, 0.25) !important;
}
.task-progress-surface[data-theme='dark'] .checklist-tasks [data-testid="checklist-panel"] {
  border-color: rgba(245, 158, 11, 0.32) !important;
  background-color: #16110b !important;
  background-image:
    linear-gradient(90deg, transparent 34px, rgba(251, 113, 133, 0.2) 34px, rgba(251, 113, 133, 0.2) 35px, transparent 35px),
    repeating-linear-gradient(180deg, transparent 0, transparent 27px, rgba(245, 158, 11, 0.08) 27px, rgba(245, 158, 11, 0.08) 28px) !important;
  color: #fef3c7 !important;
}
.task-progress-surface .checklist-tasks .checklist-header {
  border-bottom: 2px solid rgba(217, 119, 6, 0.22);
  padding-bottom: 8px;
  margin-bottom: 10px;
  font-weight: 600;
}
.task-progress-surface .checklist-tasks .checklist-steps {
  counter-reset: lx-ledger-step;
  gap: 6px !important;
}
.task-progress-surface .checklist-tasks .checklist-step {
  counter-increment: lx-ledger-step;
  position: relative;
  border-radius: 8px;
  padding: 5px 8px;
  background: rgba(255, 255, 255, 0.65);
  border: 1px solid rgba(217, 119, 6, 0.14);
}
.task-progress-surface[data-theme='dark'] .checklist-tasks .checklist-step {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(245, 158, 11, 0.12);
}
.task-progress-surface .checklist-tasks .checklist-step::before {
  content: counter(lx-ledger-step, decimal-leading-zero);
  position: absolute;
  left: -34px;
  top: 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  color: rgba(180, 83, 9, 0.72);
}
.task-progress-surface[data-theme='dark'] .checklist-tasks .checklist-step::before {
  color: rgba(251, 191, 36, 0.65);
}
.task-progress-surface .checklist-tasks .checklist-step[data-status='IN_PROGRESS'] {
  background: rgba(254, 243, 199, 0.85) !important;
  border-color: rgba(217, 119, 6, 0.45) !important;
  animation: lx-ledger-highlight 2s ease-in-out infinite;
}
.task-progress-surface[data-theme='dark'] .checklist-tasks .checklist-step[data-status='IN_PROGRESS'] {
  background: rgba(120, 53, 15, 0.38) !important;
}
.task-progress-surface .checklist-tasks .checklist-step[data-status='COMPLETED'] .checklist-content {
  text-decoration: line-through;
  text-decoration-color: rgba(180, 83, 9, 0.45);
  opacity: 0.72;
}
.task-progress-surface .checklist-tasks .checklist-status {
  padding: 1px 7px;
  border-radius: 4px;
  border: 1px solid rgba(217, 119, 6, 0.3);
  font-size: 10px !important;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
`,
};
