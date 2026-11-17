import type {OfficialPackDefinition} from '../types';

/** 外部纯 CSS 极限示例（待发送队列）：无需替换 Vue 组件，仅靠 cssText 实现赛博磁带工业风。 */
export const amberCraftPendingQueuePack: OfficialPackDefinition = {
  id: 'amber-craft-pending-queue',
  cssText: `
@keyframes lx-tape-scroll {
  0% { background-position: 0 0; }
  100% { background-position: 48px 0; }
}
[data-testid="pending-chat-queue"] > section {
  position: relative;
  overflow: hidden;
  border-radius: 12px !important;
  border: 1px solid rgba(245, 158, 11, 0.42) !important;
  background: linear-gradient(180deg, rgba(255, 251, 235, 0.96), rgba(255, 255, 255, 0.98)) !important;
  padding-top: 14px !important;
  box-shadow: 0 12px 30px -10px rgba(217, 119, 6, 0.25) !important;
}
html[data-theme="dark"] [data-testid="pending-chat-queue"] > section {
  border-color: rgba(251, 191, 36, 0.38) !important;
  background: linear-gradient(180deg, rgba(24, 18, 11, 0.95), rgba(14, 14, 18, 0.96)) !important;
  box-shadow: 0 14px 36px -10px rgba(0, 0, 0, 0.78), 0 0 20px -8px rgba(245, 158, 11, 0.25) !important;
}
[data-testid="pending-chat-queue"] > section::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 4px;
  background: repeating-linear-gradient(
    -55deg,
    #f59e0b 0,
    #f59e0b 10px,
    #18181b 10px,
    #18181b 20px
  );
  background-size: 48px 48px;
  animation: lx-tape-scroll 1.6s linear infinite;
}
[data-testid="pending-chat-queue"] > section h3 {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
[data-testid="pending-chat-queue"] > section ol > li {
  border-radius: 8px !important;
  border: 1px solid rgba(217, 119, 6, 0.18) !important;
  border-left: 3px solid #f59e0b !important;
  transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease !important;
}
[data-testid="pending-chat-queue"] > section ol > li:hover {
  transform: translateX(2px);
  border-color: rgba(245, 158, 11, 0.52) !important;
  box-shadow: 0 4px 12px -6px rgba(245, 158, 11, 0.32);
}
[data-testid="pending-chat-queue"] > section ol > li > span:first-child {
  border-radius: 4px !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(245, 158, 11, 0.18) !important;
  color: #b45309 !important;
}
html[data-theme="dark"] [data-testid="pending-chat-queue"] > section ol > li > span:first-child {
  color: #fcd34d !important;
}
[data-testid="pending-chat-queue"] [data-testid="pending-confirm-btn"] {
  border-radius: 6px !important;
  border: 1px solid rgba(16, 185, 129, 0.45);
}
`,
};
