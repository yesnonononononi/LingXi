import type {OfficialPackDefinition} from '../types';

/** 外部纯 CSS 极限示例（后台任务）：无需替换 Vue 组件，仅靠 cssText 与宿主 DOM 锚点实现声呐雷达风格。 */
export const amberCraftBackgroundTaskPack: OfficialPackDefinition = {
  id: 'amber-craft-background-task',
  cssText: `
@keyframes lx-sonar-sweep {
  0% { transform: translateX(-100%); opacity: 0; }
  35% { opacity: 0.55; }
  100% { transform: translateX(220%); opacity: 0; }
}
@keyframes lx-sonar-ping {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
  70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}
.task-progress-surface .background-tasks [data-testid="background-task-toggle"] {
  position: relative;
  overflow: hidden;
  border-radius: 10px !important;
  border: 1px solid rgba(16, 185, 129, 0.45) !important;
  background: linear-gradient(135deg, rgba(236, 253, 245, 0.96), rgba(240, 249, 255, 0.92)) !important;
  color: #065f46 !important;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 4px 14px -4px rgba(16, 185, 129, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.85) !important;
  transition: transform 160ms ease, box-shadow 180ms ease, border-color 180ms ease !important;
}
.task-progress-surface[data-theme='dark'] .background-tasks [data-testid="background-task-toggle"] {
  border-color: rgba(52, 211, 153, 0.45) !important;
  background: linear-gradient(135deg, rgba(6, 24, 22, 0.94), rgba(9, 20, 32, 0.94)) !important;
  color: #6ee7b7 !important;
  box-shadow: 0 4px 18px -4px rgba(16, 185, 129, 0.35), inset 0 1px 0 rgba(52, 211, 153, 0.16) !important;
}
.task-progress-surface .background-tasks [data-testid="background-task-toggle"]::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 42%;
  background: linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.2), transparent);
  animation: lx-sonar-sweep 3.2s ease-in-out infinite;
  pointer-events: none;
}
.task-progress-surface .background-tasks [data-testid="background-task-toggle"]:hover {
  transform: translateY(-1px);
  border-color: rgba(16, 185, 129, 0.8) !important;
}
.task-progress-surface .background-tasks [data-testid="background-task-panel"] {
  border-radius: 16px !important;
  border: 1px solid rgba(16, 185, 129, 0.35) !important;
  background: radial-gradient(circle at top right, rgba(16, 185, 129, 0.08), transparent 46%), rgba(255, 255, 255, 0.97) !important;
  backdrop-filter: blur(18px) !important;
  box-shadow: 0 18px 44px -12px rgba(6, 95, 70, 0.22), 0 0 0 1px rgba(16, 185, 129, 0.08) !important;
}
.task-progress-surface[data-theme='dark'] .background-tasks [data-testid="background-task-panel"] {
  border-color: rgba(52, 211, 153, 0.32) !important;
  background: radial-gradient(circle at top right, rgba(16, 185, 129, 0.14), transparent 48%), rgba(7, 15, 18, 0.96) !important;
  box-shadow: 0 22px 52px -12px rgba(0, 0, 0, 0.8), 0 0 24px -8px rgba(16, 185, 129, 0.25) !important;
}
.task-progress-surface .background-tasks .task-panel-header {
  padding-bottom: 10px !important;
  margin-bottom: 10px !important;
  border-bottom: 1px dashed rgba(16, 185, 129, 0.28) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  letter-spacing: 0.02em;
}
.task-progress-surface .background-tasks .task-row {
  position: relative;
  border-left: 3px solid rgba(148, 163, 184, 0.35);
  border-radius: 8px !important;
  padding: 5px 8px !important;
  margin-bottom: 4px;
  transition: background-color 150ms ease, transform 150ms ease !important;
}
.task-progress-surface .background-tasks .task-row[data-status='RUNNING'] {
  border-left-color: #10b981;
  background: linear-gradient(90deg, rgba(16, 185, 129, 0.11), transparent 72%) !important;
  animation: lx-sonar-ping 2.2s infinite;
}
.task-progress-surface .background-tasks .task-row[data-status='FAILED'],
.task-progress-surface .background-tasks .task-row[data-status='TIMEOUT'] {
  border-left-color: #f43f5e;
  background: linear-gradient(90deg, rgba(244, 63, 94, 0.1), transparent 72%) !important;
}
.task-progress-surface .background-tasks .task-row[data-status='SUCCESS'] {
  border-left-color: #06b6d4;
}
.task-progress-surface .background-tasks .task-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.task-progress-surface .background-tasks .task-state {
  font-variant-numeric: tabular-nums;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.12);
  color: #059669 !important;
}
.task-progress-surface[data-theme='dark'] .background-tasks .task-state {
  background: rgba(52, 211, 153, 0.14);
  color: #6ee7b7 !important;
}
.task-progress-surface .background-tasks .task-output {
  margin-top: 12px !important;
  padding: 10px 12px !important;
  border-radius: 10px;
  border: 1px solid rgba(16, 185, 129, 0.25) !important;
  background: rgba(2, 6, 23, 0.92) !important;
  color: #d1fae5 !important;
}
.task-progress-surface .background-tasks .task-output-header {
  color: #6ee7b7 !important;
}
.task-progress-surface .background-tasks .task-output pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #a7f3d0 !important;
}
`,
};
