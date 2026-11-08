#!/usr/bin/env node
/**
 * 前端测试统一 runner。
 *
 * 为什么存在：旧的 `test:all` 是一条 3886 字符的 `&&` 长链（tsx 段 ×2 + node 段 ×1 + electron smoke ×16）。
 * 它有三个结构性缺陷：
 *   1. `&&` 语义下「一个红就中断后续全部」——排在后面的段根本不会被执行，历史漏红就是这么来的；
 *   2. 无法只跑一个子集（改一行卡片代码也要等 17 分钟全量）；
 *   3. 没有耗时可见性，无法判断哪一段在拖后腿。
 *
 * 本 runner 把那条长链拆成显式的「场景（scene）→ 块（chunk）」结构：
 *   - 块 = 一次子进程调用：一个 tsx 批次、一个 node 批次，或一个 electron smoke（单文件）；
 *   - 场景 = 按域聚合的一组块（slots / process / session / cards / settings / unit），
 *            `all` 场景与旧 `test:all` 逐字等价（成员集合和顺序都一致）；
 *   - 默认「失败聚合不中断」：所有块都跑完，末尾打印汇总表，任一红则退出码 1；
 *   - tsx / node 段按原有并行度串行执行；electron smoke 走独立并发池（`--parallel`），
 *     不与 tsx/node 混跑抢占 CPU。
 *
 * 产物（全部落在 frontend/node_modules/.tmp/test-runner 下，不进 git、不污染源码树）：
 *   - logs/<runId>/<stepId>.log：每个块的完整 stdout/stderr；
 *   - logs/<runId>/summary.json：本次运行的结构化记录（每个块的起止时间、退出码、日志路径）；
 *   - durations.json：每个块的最近一次耗时，`--list` 会用它显示历史耗时。
 *
 * 用法见 `node scripts/test-runner.mjs --help`。
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(CURRENT_FILE_PATH);
/** 前端仓根目录（所有子进程的 cwd，命令里的相对路径都相对它）。 */
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..');
/** runner 自己的产物根目录（已被 .gitignore 的 node_modules 覆盖）。 */
const ARTIFACT_ROOT = path.join(FRONTEND_ROOT, 'node_modules', '.tmp', 'test-runner');
const LOG_ROOT = path.join(ARTIFACT_ROOT, 'logs');
const DURATION_FILE = path.join(ARTIFACT_ROOT, 'durations.json');

/** 块类型：三种子进程形态。 */
const KIND_TSX = 'tsx';
const KIND_NODE = 'node';
const KIND_SMOKE = 'smoke';
const VALID_KINDS = [KIND_TSX, KIND_NODE, KIND_SMOKE];

/** 退出码约定：0 全绿 / 1 有红 / 2 用法错误 / 3 内部分组配置自证失败。 */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_CONFIG = 3;

/** 单个块的兜底超时（毫秒）。smoke 自身多数有 180s 内部 deadline，这里给足余量。 */
const DEFAULT_CHUNK_TIMEOUT_MS = 15 * 60 * 1000;
/** 在内存中保留给失败摘要的末尾行数。 */
const TAIL_LINE_LIMIT = 40;

/**
 * 旧 `test:all` 原文，逐字快照。
 * 用途：启动时做「成员集合 + 顺序」自证——`all` 场景必须与它完全等价，
 * 任何人不小心改了分组都会在这里被拦下（退出码 3），而不是悄悄少跑一个文件。
 */
const LEGACY_TEST_ALL = 'npx tsx --test tests/applicationSessionState.test.ts tests/processViewModel.test.ts tests/toolRowUi.test.ts tests/processSegments.test.ts tests/processHeadline.test.ts tests/turnProjection.test.ts tests/processTimeline.test.ts tests/executionCleanup.test.ts tests/modelRetry.test.ts tests/subSessionLiveRetry.test.ts tests/subSessionContextUsage.test.ts tests/subSessionTaskProgress.test.ts tests/choiceNavigation.test.ts tests/tokenAuditPresentation.test.ts && npx tsx --test tests/agentSelectionPersistence.test.ts tests/backgroundTasks.test.ts tests/checklist.test.ts tests/blockEventWiring.test.ts tests/blockProjection.test.ts tests/blockTransmissionContract.test.ts tests/cancelledEmptyTurn.test.ts tests/cardReadinessAndSessionStream.test.ts tests/chatExecutionControls.test.ts tests/chatImages.test.ts tests/chatInputFocusContract.test.ts tests/chatLiveRenderFixes.test.ts tests/crossPageTurn.test.ts tests/desktopNotification.test.ts tests/suspensionNotification.test.ts tests/failedTurnBubble.test.ts tests/frontendRenderFix.test.ts tests/i18n.test.ts tests/mcpConnect.test.ts tests/mcpConnectComponent.test.ts tests/modelIdPrecision.test.ts tests/modelProviderCredential.test.ts tests/notificationSound.test.ts tests/personalization.test.ts tests/planCardLoading.test.ts tests/promiseCard.test.ts tests/promptCardGroups.test.ts tests/promptCardSinglePath.test.ts tests/promptOptimization.test.ts tests/qaAsyncSubSessionStatusAdversarial.test.ts tests/qaIndependentVerification.test.ts tests/qaIsBodyIndependent.test.ts tests/readImageTools.test.ts tests/reasoningEffort.test.ts tests/compactionSettings.test.ts tests/responseTextStreaming.test.ts tests/sessionLoadDiagnosis.test.ts tests/sidebarBehavior.test.ts tests/singleSessionStream.test.ts tests/skillCommand.test.ts tests/sseParse.test.ts tests/streamAnimationGuard.test.ts tests/progressiveFade.test.ts tests/thinkingTextScheduler.test.ts tests/streamRendering.test.ts tests/subSessionHistoryReuse.test.ts tests/textTypeLocale.test.ts tests/themeTokens.test.ts tests/fontScale.test.ts tests/tokenUsage.test.ts tests/toolDisplayName.test.ts tests/toolDisplayNames.test.ts tests/toolSettingsDisplay.test.ts tests/unsentUserBubble.test.ts tests/projectPagePreview.test.ts tests/toolCallConflictContract.test.ts tests/executionCleanupOrphanScan.test.ts tests/settingsSync.test.ts && node --test tests/progressiveFade.test.cjs tests/thinkingText.test.cjs tests/mermaid.test.cjs tests/developmentIsolation.test.cjs tests/backendRuntimeMaven.test.cjs tests/backendSandbox.test.cjs tests/chatAsyncDelegationStatus.test.cjs tests/chatModelSourceIndicator.test.cjs tests/chatProcessCollapse.test.cjs tests/chatScrollResize.test.cjs tests/choiceCardQuestionNewline.test.cjs tests/collapseTransitionClip.test.cjs tests/loadingSweep.test.cjs tests/statusIndicator.test.cjs tests/electronPackaging.test.cjs tests/filePreview.native.test.cjs tests/footerStatusWidth.test.cjs tests/chatColumnWidth.test.cjs tests/frameworkDependencies.test.cjs tests/frameworkLockDoctor.test.cjs tests/qaAsyncDelegationAdversarial.test.cjs tests/qaDelegationCompatRemoval.test.cjs tests/sandboxRuntime.test.cjs tests/sandboxRuntimeFetch.test.cjs tests/processDetailsSplit.test.cjs tests/slingButton.test.cjs tests/updateRuntimeContract.test.cjs tests/updateSecurity.test.cjs tests/updateSignatureContract.test.cjs tests/chatBackground.test.cjs tests/visualExpectInventory.test.cjs tests/backgroundSlots.test.cjs && npx electron tests/chatMessageSlots.smoke.cjs && npx electron tests/backgroundImage.smoke.cjs && npx electron tests/chatInputSlots.smoke.cjs && npx electron tests/sidebarSlots.smoke.cjs && npx electron tests/processSegments.smoke.cjs && npx electron tests/chatExecutionControls.smoke.cjs && npx electron tests/sessionRecovery.smoke.cjs && npx electron tests/subSessionContextUsage.smoke.cjs && npx electron tests/subSessionTaskProgress.smoke.cjs && npx electron tests/suspensionNotification.smoke.cjs && npx electron tests/planPreview.smoke.cjs && npx electron tests/taskProgress.smoke.cjs && npx electron tests/choiceQuestionGroup.smoke.cjs && npx electron tests/commandApprovalGroup.smoke.cjs && npx electron tests/compactionSettings.smoke.cjs && npx electron tests/settingsBackground.smoke.cjs && npx electron tests/messageImages.smoke.cjs && npx electron tests/projectPagePreview.smoke.cjs';

/** 旧链的第一段 tsx 批次（14 个文件）。 */
const TSX_SEGMENT_ONE = [
  'tests/applicationSessionState.test.ts',
  'tests/processViewModel.test.ts',
  'tests/toolRowUi.test.ts',
  'tests/processSegments.test.ts',
  'tests/processHeadline.test.ts',
  'tests/turnProjection.test.ts',
  'tests/processTimeline.test.ts',
  'tests/executionCleanup.test.ts',
  'tests/modelRetry.test.ts',
  'tests/subSessionLiveRetry.test.ts',
  'tests/subSessionContextUsage.test.ts',
  'tests/subSessionTaskProgress.test.ts',
  'tests/choiceNavigation.test.ts',
  'tests/tokenAuditPresentation.test.ts',
];

/** 旧链的第二段 tsx 批次（52 个文件；S4 起含 tests/fontScale.test.ts）。 */
const TSX_SEGMENT_TWO = [
  'tests/agentSelectionPersistence.test.ts',
  'tests/backgroundTasks.test.ts',
  'tests/checklist.test.ts',
  'tests/blockEventWiring.test.ts',
  'tests/blockProjection.test.ts',
  'tests/blockTransmissionContract.test.ts',
  'tests/cancelledEmptyTurn.test.ts',
  'tests/cardReadinessAndSessionStream.test.ts',
  'tests/chatExecutionControls.test.ts',
  'tests/chatImages.test.ts',
  'tests/chatInputFocusContract.test.ts',
  'tests/chatLiveRenderFixes.test.ts',
  'tests/crossPageTurn.test.ts',
  'tests/desktopNotification.test.ts',
  'tests/suspensionNotification.test.ts',
  'tests/failedTurnBubble.test.ts',
  'tests/frontendRenderFix.test.ts',
  'tests/i18n.test.ts',
  'tests/mcpConnect.test.ts',
  'tests/mcpConnectComponent.test.ts',
  'tests/modelIdPrecision.test.ts',
  'tests/modelProviderCredential.test.ts',
  'tests/notificationSound.test.ts',
  'tests/personalization.test.ts',
  'tests/planCardLoading.test.ts',
  'tests/promiseCard.test.ts',
  'tests/promptCardGroups.test.ts',
  'tests/promptCardSinglePath.test.ts',
  'tests/promptOptimization.test.ts',
  'tests/qaAsyncSubSessionStatusAdversarial.test.ts',
  'tests/qaIndependentVerification.test.ts',
  'tests/qaIsBodyIndependent.test.ts',
  'tests/readImageTools.test.ts',
  'tests/reasoningEffort.test.ts',
  'tests/compactionSettings.test.ts',
  'tests/responseTextStreaming.test.ts',
  'tests/sessionLoadDiagnosis.test.ts',
  'tests/sidebarBehavior.test.ts',
  'tests/singleSessionStream.test.ts',
  'tests/skillCommand.test.ts',
  'tests/sseParse.test.ts',
  'tests/streamAnimationGuard.test.ts',
  'tests/progressiveFade.test.ts',
  'tests/thinkingTextScheduler.test.ts',
  'tests/streamRendering.test.ts',
  'tests/subSessionHistoryReuse.test.ts',
  'tests/textTypeLocale.test.ts',
  'tests/themeTokens.test.ts',
  'tests/fontScale.test.ts',
  'tests/tokenUsage.test.ts',
  'tests/toolDisplayName.test.ts',
  'tests/toolDisplayNames.test.ts',
  'tests/toolSettingsDisplay.test.ts',
  'tests/unsentUserBubble.test.ts',
  'tests/projectPagePreview.test.ts',
  'tests/toolCallConflictContract.test.ts',
  'tests/executionCleanupOrphanScan.test.ts',
  'tests/settingsSync.test.ts',
];

/** 旧链的 node 批次（29 个 .test.cjs）。 */
const NODE_SEGMENT = [
  'tests/progressiveFade.test.cjs',
  'tests/thinkingText.test.cjs',
  'tests/mermaid.test.cjs',
  'tests/developmentIsolation.test.cjs',
  'tests/backendRuntimeMaven.test.cjs',
  'tests/backendSandbox.test.cjs',
  'tests/chatAsyncDelegationStatus.test.cjs',
  'tests/chatModelSourceIndicator.test.cjs',
  'tests/chatProcessCollapse.test.cjs',
  'tests/chatScrollResize.test.cjs',
  'tests/choiceCardQuestionNewline.test.cjs',
  'tests/collapseTransitionClip.test.cjs',
  'tests/loadingSweep.test.cjs',
  'tests/statusIndicator.test.cjs',
  'tests/electronPackaging.test.cjs',
  'tests/filePreview.native.test.cjs',
  'tests/footerStatusWidth.test.cjs',
  'tests/chatColumnWidth.test.cjs',
  'tests/frameworkDependencies.test.cjs',
  'tests/frameworkLockDoctor.test.cjs',
  'tests/qaAsyncDelegationAdversarial.test.cjs',
  'tests/qaDelegationCompatRemoval.test.cjs',
  'tests/sandboxRuntime.test.cjs',
  'tests/sandboxRuntimeFetch.test.cjs',
  'tests/processDetailsSplit.test.cjs',
  'tests/slingButton.test.cjs',
  'tests/updateRuntimeContract.test.cjs',
  'tests/updateSecurity.test.cjs',
  'tests/updateSignatureContract.test.cjs',
  'tests/chatBackground.test.cjs',
  'tests/visualExpectInventory.test.cjs',
  'tests/backgroundSlots.test.cjs',
];

/** 旧链尾部 16 个 electron smoke（顺序即旧链顺序）。 */
const SMOKE_SEGMENT = [
  'chatMessageSlots',
  'backgroundImage',
  'chatInputSlots',
  'sidebarSlots',
  'processSegments',
  'chatExecutionControls',
  'sessionRecovery',
  'subSessionContextUsage',
  'subSessionTaskProgress',
  'suspensionNotification',
  'planPreview',
  'taskProgress',
  'choiceQuestionGroup',
  'commandApprovalGroup',
  'compactionSettings',
  'settingsBackground',
  'messageImages',
  'projectPagePreview',
];

/**
 * 场景分组表（唯一可信配置源，全部显式写死，便于审阅）。
 *
 * 每个场景给出三类块的成员：
 *   - `tsx`：tsx 批次文件（按批次渲染成 `npx tsx --test <files>`）；
 *   - `node`：node 批次文件（按批次渲染成 `node --test <files>`）；
 *   - `smoke`：electron smoke 的 id 列表（每个 id 单独一次 `npx electron tests/<id>.smoke.cjs`，可并行）。
 *
 * 约束（启动时由 `verifySceneCoverage()` 强校验）：
 *   - 除 `all` 外所有场景的成员并集 = `all` 的成员全集，且两两不重叠（不重不漏）；
 *   - `all` 的块列表与 `LEGACY_TEST_ALL` 逐字等价。
 */
const SCENES = {
  all: {
    description: '旧 test:all 全量（默认；成员集合与顺序逐字等价）',
    chunks: [
      { kind: KIND_TSX, files: TSX_SEGMENT_ONE },
      { kind: KIND_TSX, files: TSX_SEGMENT_TWO },
      { kind: KIND_NODE, files: NODE_SEGMENT },
      ...SMOKE_SEGMENT.map((smokeId) => ({ kind: KIND_SMOKE, files: [toSmokeTestPath(smokeId)] })),
    ],
  },
  slots: {
    description: '插槽化与背景域（消息/输入/侧栏插槽、背景图层与相关单测）',
    chunks: [
      { kind: KIND_TSX, files: ['tests/sidebarBehavior.test.ts'] },
      { kind: KIND_NODE, files: ['tests/chatBackground.test.cjs', 'tests/backgroundSlots.test.cjs'] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('chatMessageSlots')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('messageImages')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('backgroundImage')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('chatInputSlots')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('sidebarSlots')] },
    ],
  },
  process: {
    description: '过程流域（过程投影/时间线/工具行折叠与 processSegments 真渲染）',
    chunks: [
      {
        kind: KIND_TSX,
        files: [
          'tests/processViewModel.test.ts',
          'tests/toolRowUi.test.ts',
          'tests/processSegments.test.ts',
          'tests/processHeadline.test.ts',
          'tests/turnProjection.test.ts',
          'tests/processTimeline.test.ts',
          'tests/executionCleanup.test.ts',
        ],
      },
      { kind: KIND_NODE, files: ['tests/chatProcessCollapse.test.cjs', 'tests/processDetailsSplit.test.cjs'] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('processSegments')] },
    ],
  },
  session: {
    description: '会话域（会话恢复、子会话上下文/进度、挂起通知）',
    chunks: [
      {
        kind: KIND_TSX,
        files: [
          'tests/applicationSessionState.test.ts',
          'tests/subSessionLiveRetry.test.ts',
          'tests/subSessionContextUsage.test.ts',
          'tests/subSessionTaskProgress.test.ts',
          'tests/crossPageTurn.test.ts',
          'tests/suspensionNotification.test.ts',
          'tests/sessionLoadDiagnosis.test.ts',
          'tests/singleSessionStream.test.ts',
          'tests/subSessionHistoryReuse.test.ts',
          'tests/executionCleanupOrphanScan.test.ts',
        ],
      },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('sessionRecovery')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('subSessionContextUsage')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('subSessionTaskProgress')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('suspensionNotification')] },
    ],
  },
  cards: {
    description: '卡片域（计划/任务进度/选择题/审批/执行控制条）',
    chunks: [
      {
        kind: KIND_TSX,
        files: [
          'tests/choiceNavigation.test.ts',
          'tests/cardReadinessAndSessionStream.test.ts',
          'tests/chatExecutionControls.test.ts',
          'tests/planCardLoading.test.ts',
          'tests/promiseCard.test.ts',
          'tests/promptCardGroups.test.ts',
          'tests/promptCardSinglePath.test.ts',
          'tests/projectPagePreview.test.ts',
          'tests/toolCallConflictContract.test.ts',
        ],
      },
      { kind: KIND_NODE, files: ['tests/choiceCardQuestionNewline.test.cjs'] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('chatExecutionControls')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('planPreview')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('projectPagePreview')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('taskProgress')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('choiceQuestionGroup')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('commandApprovalGroup')] },
    ],
  },
  settings: {
    description: '设置域（压缩设置、个性化、工具显示与背景设置）',
    chunks: [
      {
        kind: KIND_TSX,
        files: [
          'tests/personalization.test.ts',
          'tests/reasoningEffort.test.ts',
          'tests/compactionSettings.test.ts',
          'tests/toolSettingsDisplay.test.ts',
          'tests/settingsSync.test.ts',
        ],
      },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('compactionSettings')] },
      { kind: KIND_SMOKE, files: [toSmokeTestPath('settingsBackground')] },
    ],
  },
  unit: {
    description: '其余纯单测（tsx + node，不启 electron）',
    chunks: [
      {
        kind: KIND_TSX,
        files: [
          'tests/modelRetry.test.ts',
          'tests/agentSelectionPersistence.test.ts',
          'tests/backgroundTasks.test.ts',
          'tests/checklist.test.ts',
          'tests/blockEventWiring.test.ts',
          'tests/blockProjection.test.ts',
          'tests/blockTransmissionContract.test.ts',
          'tests/cancelledEmptyTurn.test.ts',
          'tests/chatImages.test.ts',
          'tests/chatInputFocusContract.test.ts',
          'tests/chatLiveRenderFixes.test.ts',
          'tests/desktopNotification.test.ts',
          'tests/failedTurnBubble.test.ts',
          'tests/frontendRenderFix.test.ts',
          'tests/i18n.test.ts',
          'tests/mcpConnect.test.ts',
          'tests/mcpConnectComponent.test.ts',
          'tests/modelIdPrecision.test.ts',
          'tests/modelProviderCredential.test.ts',
          'tests/notificationSound.test.ts',
          'tests/promptOptimization.test.ts',
          'tests/qaAsyncSubSessionStatusAdversarial.test.ts',
          'tests/qaIndependentVerification.test.ts',
          'tests/qaIsBodyIndependent.test.ts',
          'tests/readImageTools.test.ts',
          'tests/responseTextStreaming.test.ts',
          'tests/skillCommand.test.ts',
          'tests/sseParse.test.ts',
          'tests/streamAnimationGuard.test.ts',
          'tests/progressiveFade.test.ts',
          'tests/thinkingTextScheduler.test.ts',
          'tests/streamRendering.test.ts',
          'tests/textTypeLocale.test.ts',
          'tests/themeTokens.test.ts',
          'tests/fontScale.test.ts',
          'tests/tokenUsage.test.ts',
          'tests/tokenAuditPresentation.test.ts',
          'tests/toolDisplayName.test.ts',
          'tests/toolDisplayNames.test.ts',
          'tests/unsentUserBubble.test.ts',
        ],
      },
      {
        kind: KIND_NODE,
        files: [
          'tests/progressiveFade.test.cjs',
          'tests/thinkingText.test.cjs',
          'tests/mermaid.test.cjs',
          'tests/developmentIsolation.test.cjs',
          'tests/backendRuntimeMaven.test.cjs',
          'tests/backendSandbox.test.cjs',
          'tests/chatAsyncDelegationStatus.test.cjs',
          'tests/chatModelSourceIndicator.test.cjs',
          'tests/chatScrollResize.test.cjs',
          'tests/collapseTransitionClip.test.cjs',
          'tests/loadingSweep.test.cjs',
          'tests/statusIndicator.test.cjs',
          'tests/electronPackaging.test.cjs',
          'tests/filePreview.native.test.cjs',
          'tests/footerStatusWidth.test.cjs',
          'tests/chatColumnWidth.test.cjs',
          'tests/frameworkDependencies.test.cjs',
          'tests/frameworkLockDoctor.test.cjs',
          'tests/qaAsyncDelegationAdversarial.test.cjs',
          'tests/qaDelegationCompatRemoval.test.cjs',
          'tests/sandboxRuntime.test.cjs',
          'tests/sandboxRuntimeFetch.test.cjs',
          'tests/slingButton.test.cjs',
          'tests/updateRuntimeContract.test.cjs',
          'tests/updateSecurity.test.cjs',
          'tests/updateSignatureContract.test.cjs',
          'tests/visualExpectInventory.test.cjs',
        ],
      },
    ],
  },
};

/**
 * 把 smoke id 映射成相对路径。
 * @param {string} smokeId 例如 `chatMessageSlots`
 * @returns {string} 例如 `tests/chatMessageSlots.smoke.cjs`
 */
function toSmokeTestPath(smokeId) {
  return `tests/${smokeId}.smoke.cjs`;
}

/** 场景名列表（保持声明顺序，供报错与 `--list` 使用）。 */
const SCENE_NAMES = Object.keys(SCENES);

/** 用法说明文本。 */
const USAGE_TEXT = [
  '前端测试统一 runner（scripts/test-runner.mjs）',
  '',
  '用法：',
  '  node scripts/test-runner.mjs [选项]',
  '',
  '选项：',
  '  --scenes <name[,name...]>  只跑指定场景组；缺省等价 all（= 旧 test:all 全集）',
  '  --parallel <n>             electron smoke 并发上限，默认 min(4, max(2, cpus/2))；n=1 为串行',
  '  --filter <keyword>         按关键字（匹配文件路径）从所有组里挑出命中项跑；与 --scenes 互斥',
  '  --fail-fast                命中失败立即中断（旧 && 行为），默认是失败聚合不中断',
  '  --list                     只打印场景组、成员与历史耗时，不执行任何测试',
  '  --help                     打印本说明',
  '',
  `合法场景组：${SCENE_NAMES.join(' / ')}`,
  '',
  '示例：',
  '  npm run test:scenes -- --scenes slots --parallel 2',
  '  npm run test:scenes -- --filter planPreview',
  '  node scripts/test-runner.mjs --scenes all --parallel 2',
].join('\n');

/**
 * 确保父目录存在。
 * @param {string} dirPath 目录绝对路径
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

/**
 * 把毫秒格式化成人类可读的耗时。
 * @param {number} milliseconds 毫秒数（>=0）
 * @returns {string} 例如 `21.3s` / `8m12s`
 */
function formatDuration(milliseconds) {
  const safeValue = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  const totalSeconds = safeValue / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m${seconds.toFixed(0)}s`;
}

/**
 * 生成一种块的命令行文本。
 * @param {{kind: string, files: string[]}} chunk 块定义
 * @returns {string} 可直接交给 shell 的命令行
 */
function buildCommandLine(chunk) {
  const joined = chunk.files.map((file) => quoteShellArg(file)).join(' ');
  if (chunk.kind === KIND_TSX) {
    return `npx tsx --test ${joined}`;
  }
  if (chunk.kind === KIND_NODE) {
    return `node --test ${joined}`;
  }
  return `npx electron ${joined}`;
}

/**
 * 简单的 shell 参数转义：本项目里的路径只含 `[A-Za-z0-9./_-]`，含空白时才加引号。
 * @param {string} value 原始参数
 * @returns {string} 安全参数
 */
function quoteShellArg(value) {
  if (/^[A-Za-z0-9._/:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

/**
 * 计算默认并发度：min(4, max(2, floor(cpus/2)))，且不超过 CPU 核数。
 * @returns {number} 默认并行上限（>=1）
 */
function defaultParallelism() {
  const cpuCount = Math.max(1, os.cpus().length);
  return Math.max(1, Math.min(4, Math.max(2, Math.floor(cpuCount / 2))));
}

/**
 * 解析命令行参数。
 * @param {string[]} argv 去掉 node 与脚本路径后的参数列表
 * @returns {{scenes: string[]|null, parallel: number, filter: string|null, failFast: boolean, list: boolean, help: boolean}}
 * @throws {Error} 参数非法时抛出（调用方转成退出码 2）
 */
function parseArguments(argv) {
  const parsed = {
    scenes: null,
    parallel: defaultParallelism(),
    filter: null,
    failFast: false,
    list: false,
    help: false,
  };
  const readValue = (index, flagName) => {
    const candidate = argv[index];
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.startsWith('--')) {
      throw new Error(`${flagName} 缺少取值`);
    }
    return candidate;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalIndex = token.indexOf('=');
    const flagName = token.startsWith('--') && equalIndex > 0 ? token.slice(0, equalIndex) : token;
    const inlineValue = token.startsWith('--') && equalIndex > 0 ? token.slice(equalIndex + 1) : null;

    if (flagName === '--help' || flagName === '-h') {
      parsed.help = true;
      continue;
    }
    if (flagName === '--list') {
      parsed.list = true;
      continue;
    }
    if (flagName === '--fail-fast') {
      parsed.failFast = true;
      continue;
    }
    if (flagName === '--scenes') {
      const rawValue = inlineValue !== null ? inlineValue : readValue(index + 1, '--scenes');
      if (inlineValue === null) {
        index += 1;
      }
      const names = rawValue
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length === 0) {
        throw new Error('--scenes 至少需要一个场景名');
      }
      parsed.scenes = names;
      continue;
    }
    if (flagName === '--parallel') {
      const rawValue = inlineValue !== null ? inlineValue : readValue(index + 1, '--parallel');
      if (inlineValue === null) {
        index += 1;
      }
      const parallel = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(parallel) || parallel < 1 || String(parallel) !== rawValue.trim()) {
        throw new Error(`--parallel 需要 >=1 的整数，收到 "${rawValue}"`);
      }
      parsed.parallel = parallel;
      continue;
    }
    if (flagName === '--filter') {
      const rawValue = inlineValue !== null ? inlineValue : readValue(index + 1, '--filter');
      if (inlineValue === null) {
        index += 1;
      }
      if (rawValue.trim().length === 0) {
        throw new Error('--filter 需要非空关键字');
      }
      parsed.filter = rawValue.trim();
      continue;
    }
    throw new Error(`未知参数 "${token}"`);
  }

  if (parsed.scenes !== null && parsed.filter !== null) {
    throw new Error('--scenes 与 --filter 互斥，请只给一个');
  }
  return parsed;
}

/**
 * 把旧 `test:all` 文本解析成块列表，用于与 `SCENES.all.chunks` 做逐字比对。
 * @param {string} legacyText 旧脚本原文
 * @returns {{kind: string, files: string[]}[]} 解析出的块列表
 */
function parseLegacyChunks(legacyText) {
  const segments = legacyText.split(' && ').map((segment) => segment.trim());
  const chunks = [];
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length >= 3 && tokens[0] === 'npx' && tokens[1] === 'tsx' && tokens[2] === '--test') {
      chunks.push({ kind: KIND_TSX, files: tokens.slice(3) });
      continue;
    }
    if (tokens.length >= 3 && tokens[0] === 'node' && tokens[1] === '--test') {
      chunks.push({ kind: KIND_NODE, files: tokens.slice(2) });
      continue;
    }
    if (tokens.length === 3 && tokens[0] === 'npx' && tokens[1] === 'electron') {
      chunks.push({ kind: KIND_SMOKE, files: [tokens[2]] });
      continue;
    }
    throw new Error(`旧 test:all 片段无法识别：${segment.slice(0, 80)}`);
  }
  return chunks;
}

/**
 * 分组自证：`all` 与旧链逐字一致；其余场景并集等于 `all` 且不重不漏；所有文件都真实存在。
 * @returns {{ok: boolean, problems: string[], totalMembers: number}} 自证结果
 */
function verifySceneCoverage() {
  const problems = [];
  const legacyChunks = parseLegacyChunks(LEGACY_TEST_ALL);
  const allChunks = SCENES.all.chunks;

  if (legacyChunks.length !== allChunks.length) {
    problems.push(`all 的块数 ${allChunks.length} 与旧链 ${legacyChunks.length} 不一致`);
  }
  const compareLength = Math.min(legacyChunks.length, allChunks.length);
  for (let index = 0; index < compareLength; index += 1) {
    const legacy = legacyChunks[index];
    const current = allChunks[index];
    if (legacy.kind !== current.kind) {
      problems.push(`第 ${index + 1} 块类型不一致：旧链 ${legacy.kind} / 现有 ${current.kind}`);
      continue;
    }
    if (legacy.files.join(' ') !== current.files.join(' ')) {
      problems.push(`第 ${index + 1} 块成员不一致：旧链 ${legacy.files.length} 个 / 现有 ${current.files.length} 个`);
    }
  }

  const allMembers = [];
  for (const chunk of allChunks) {
    for (const file of chunk.files) {
      allMembers.push(file);
    }
  }
  const memberCounts = new Map();
  for (const file of allMembers) {
    memberCounts.set(file, (memberCounts.get(file) ?? 0) + 1);
  }

  const sceneMemberCounts = new Map();
  for (const sceneName of SCENE_NAMES) {
    if (sceneName === 'all') {
      continue;
    }
    const scene = SCENES[sceneName];
    const seenInScene = new Set();
    for (const chunk of scene.chunks) {
      if (!VALID_KINDS.includes(chunk.kind)) {
        problems.push(`场景 ${sceneName} 出现非法块类型 ${chunk.kind}`);
      }
      if (chunk.files.length === 0) {
        problems.push(`场景 ${sceneName} 存在空块`);
      }
      if (chunk.kind === KIND_SMOKE && chunk.files.length !== 1) {
        problems.push(`场景 ${sceneName} 的 smoke 块必须只含一个文件`);
      }
      for (const file of chunk.files) {
        if (seenInScene.has(file)) {
          problems.push(`场景 ${sceneName} 内重复成员 ${file}`);
        }
        seenInScene.add(file);
        sceneMemberCounts.set(file, (sceneMemberCounts.get(file) ?? 0) + 1);
      }
    }
  }

  for (const [file, count] of sceneMemberCounts.entries()) {
    if (count > 1) {
      problems.push(`成员 ${file} 被 ${count} 个场景重复覆盖`);
    }
  }
  for (const [file, count] of memberCounts.entries()) {
    if (count > 1) {
      problems.push(`all 中成员重复 ${file}（${count} 次）`);
    }
    const sceneCount = sceneMemberCounts.get(file) ?? 0;
    if (sceneCount !== count) {
      problems.push(`成员 ${file} 在域场景中出现 ${sceneCount} 次，但在 all 中出现 ${count} 次`);
    }
  }
  for (const file of sceneMemberCounts.keys()) {
    if (!memberCounts.has(file)) {
      problems.push(`域场景包含不属于 all 的成员 ${file}`);
    }
  }

  for (const file of memberCounts.keys()) {
    if (!fs.existsSync(path.join(FRONTEND_ROOT, file))) {
      problems.push(`成员文件不存在 ${file}`);
    }
  }

  return { ok: problems.length === 0, problems, totalMembers: allMembers.length };
}

/**
 * 读取历史耗时文件（不存在或损坏时返回空表）。
 * @returns {Promise<{updatedAt: string|null, steps: Record<string, {seconds: number, ok: boolean, at: string}>}>}
 */
async function readDurationHistory() {
  try {
    const rawText = await fsp.readFile(DURATION_FILE, 'utf8');
    const parsed = JSON.parse(rawText);
    const steps = parsed && typeof parsed === 'object' && parsed.steps && typeof parsed.steps === 'object'
      ? parsed.steps
      : {};
    return { updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null, steps };
  } catch {
    return { updatedAt: null, steps: {} };
  }
}

/**
 * 写回历史耗时文件。
 * @param {Record<string, {seconds: number, ok: boolean, at: string}>} newEntries 本次新增记录
 * @returns {Promise<void>}
 */
async function updateDurationHistory(newEntries) {
  try {
    const history = await readDurationHistory();
    const mergedSteps = { ...history.steps, ...newEntries };
    await ensureDir(ARTIFACT_ROOT);
    const payload = { updatedAt: new Date().toISOString(), steps: mergedSteps };
    await fsp.writeFile(DURATION_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[WARN] 历史耗时写入失败（不影响测试结论）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 生成块的稳定 id。
 * @param {string} sceneName 场景名
 * @param {{kind: string, files: string[]}} chunk 块定义
 * @param {number} ordinal 同场景同类型块的出现序号（从 1 开始）
 * @returns {string} 例如 `slots.chatMessageSlots` / `all.tsx#2`
 */
function stepIdFor(sceneName, chunk, ordinal) {
  if (chunk.kind === KIND_SMOKE) {
    const fileName = path.basename(chunk.files[0]);
    const stem = fileName.replace(/\.smoke\.cjs$/, '').replace(/\.cjs$/, '');
    return `${sceneName}.${stem}`;
  }
  return `${sceneName}.${chunk.kind}#${ordinal}`;
}

/**
 * 生成历史耗时的索引键：块 id + 成员数。
 * 这样 `--filter` 只跑单个文件时不会覆盖同名块的全量耗时记录。
 * @param {string} stepId 块 id
 * @param {number} memberCount 该块包含的测试文件数
 * @returns {string} 例如 `unit.tsx#1@36`
 */
function historyKeyFor(stepId, memberCount) {
  return `${stepId}@${memberCount}`;
}

/**
 * 把场景展开成可执行的块计划。
 * @param {string} sceneName 场景名
 * @param {string|null} keyword 过滤关键字（null 表示不过滤）
 * @returns {{id: string, scene: string, kind: string, files: string[]}[]} 块计划
 */
function buildPlanForScene(sceneName, keyword) {
  const scene = SCENES[sceneName];
  const plan = [];
  const ordinalByKind = new Map();
  for (const chunk of scene.chunks) {
    const ordinal = (ordinalByKind.get(chunk.kind) ?? 0) + 1;
    ordinalByKind.set(chunk.kind, ordinal);
    const files = keyword === null
      ? [...chunk.files]
      : chunk.files.filter((file) => file.toLowerCase().includes(keyword.toLowerCase()));
    if (files.length === 0) {
      continue;
    }
    plan.push({ id: stepIdFor(sceneName, { kind: chunk.kind, files }, ordinal), scene: sceneName, kind: chunk.kind, files });
  }
  return plan;
}

/**
 * 执行一个块，把输出落到日志文件。
 * @param {{id: string, scene: string, kind: string, files: string[]}} step 块计划
 * @param {string} runLogDir 本次运行的日志目录
 * @returns {Promise<{step: object, ok: boolean, exitCode: number|null, signal: string|null, durationMs: number, logPath: string, reason: string, tail: string[]}>}
 */
async function runStep(step, runLogDir) {
  const commandLine = buildCommandLine(step);
  const safeName = step.id.replace(/[^A-Za-z0-9._#-]/g, '_');
  const logPath = path.join(runLogDir, `${safeName}.log`);
  const startedAt = Date.now();
  const tail = [];
  /** 从输出里捞出的「失败用例文件」提示（形如 `test at tests/xxx.test.ts:43:1`）。 */
  const failureHints = [];
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  logStream.write(`# ${commandLine}\n# cwd: ${FRONTEND_ROOT}\n\n`);

  /** 把一段输出并入内存环形缓冲，并顺手收集失败用例提示。 */
  const pushTail = (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      tail.push(line);
      if (tail.length > TAIL_LINE_LIMIT) {
        tail.shift();
      }
      const trimmed = line.trim();
      if (failureHints.length < 10 && /test at .*\.test\.(?:ts|cjs):\d+/.test(trimmed) && !failureHints.includes(trimmed)) {
        failureHints.push(trimmed);
      }
    }
  };

  const child = spawn(commandLine, {
    cwd: FRONTEND_ROOT,
    shell: true,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    pushTail(`[runner] 超时 ${formatDuration(DEFAULT_CHUNK_TIMEOUT_MS)}，终止该块`);
    try {
      child.kill('SIGKILL');
    } catch {
      // 忽略：进程可能已退出
    }
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      spawn(`taskkill /pid ${child.pid} /T /F`, { shell: true, windowsHide: true, stdio: 'ignore' });
    }
  }, DEFAULT_CHUNK_TIMEOUT_MS);

  child.stdout?.on('data', (buffer) => {
    const text = buffer.toString('utf8');
    logStream.write(text);
    pushTail(text);
  });
  child.stderr?.on('data', (buffer) => {
    const text = buffer.toString('utf8');
    logStream.write(text);
    pushTail(text);
  });

  const outcome = await new Promise((resolve) => {
    child.on('error', (error) => {
      resolve({ exitCode: null, signal: null, spawnError: error instanceof Error ? error.message : String(error) });
    });
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, spawnError: null });
    });
  });

  clearTimeout(timeoutHandle);
  const durationMs = Date.now() - startedAt;
  const finishedAt = Date.now();
  await new Promise((resolve) => logStream.end(resolve));

  const ok = !timedOut && outcome.spawnError === null && outcome.exitCode === 0;
  let reason = '';
  if (outcome.spawnError !== null) {
    reason = `进程启动失败：${outcome.spawnError}`;
  } else if (timedOut) {
    reason = `超时（>${formatDuration(DEFAULT_CHUNK_TIMEOUT_MS)}）`;
  } else if (outcome.signal) {
    reason = `被信号 ${outcome.signal} 终止`;
  } else if (outcome.exitCode !== 0) {
    reason = `退出码 ${outcome.exitCode}`;
  }

  return {
    step,
    ok,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    durationMs,
    startedAt,
    finishedAt,
    logPath,
    reason,
    failureHints,
    tail: ok ? [] : tail.slice(-TAIL_LINE_LIMIT),
  };
}

/**
 * 打印一行结果。
 * @param {{step: object, ok: boolean, durationMs: number, reason: string}} result 块结果
 * @returns {void}
 */
function printResult(result) {
  const label = result.ok ? '[PASS]' : '[FAIL]';
  const suffix = result.ok ? '' : `  ${result.reason}`;
  console.log(`${label} ${result.step.id.padEnd(28, ' ')} ${formatDuration(result.durationMs).padStart(8, ' ')}${suffix}`);
}

/**
 * 并发受限地执行一批块。
 * @param {{id: string, scene: string, kind: string, files: string[]}[]} steps 块计划
 * @param {number} limit 并发上限
 * @param {(step: object) => Promise<object>} worker 单块执行函数
 * @param {{aborted: boolean}} state 中断状态（fail-fast 使用）
 * @returns {Promise<object[]>} 结果列表（可能少于输入，fail-fast 时截断）
 */
async function runWithLimit(steps, limit, worker, state) {
  const results = [];
  let cursor = 0;
  const safeLimit = Math.max(1, Math.min(limit, steps.length === 0 ? 1 : steps.length));

  const launch = async () => {
    while (cursor < steps.length) {
      if (state.aborted) {
        return;
      }
      const currentIndex = cursor;
      cursor += 1;
      const result = await worker(steps[currentIndex]);
      results.push(result);
      if (!result.ok) {
        if (state.onFailure?.(result) === true) {
          state.aborted = true;
        }
      }
    }
  };

  const workers = [];
  for (let slot = 0; slot < safeLimit; slot += 1) {
    workers.push(launch());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 打印场景清单（`--list`）。
 * @param {Record<string, {seconds: number, ok: boolean, at: string}>} history 历史耗时
 * @returns {void}
 */
function printSceneList(history) {
  const coverage = verifySceneCoverage();
  console.log('可用场景组：');
  for (const sceneName of SCENE_NAMES) {
    const scene = SCENES[sceneName];
    const memberCount = scene.chunks.reduce((total, chunk) => total + chunk.files.length, 0);
    const chunkCount = scene.chunks.length;
    console.log('');
    console.log(`● ${sceneName}（${memberCount} 个成员 / ${chunkCount} 个块）—— ${scene.description}`);
    const ordinalByKind = new Map();
    for (const chunk of scene.chunks) {
      const ordinal = (ordinalByKind.get(chunk.kind) ?? 0) + 1;
      ordinalByKind.set(chunk.kind, ordinal);
      const stepId = stepIdFor(sceneName, chunk, ordinal);
      // 历史耗时按「块 id + 成员数」索引：filter 跑单文件时不会覆盖全量批次的耗时。
      // 兼容旧版仅按块 id 记录的条目。
      const historyEntry = history.steps[historyKeyFor(stepId, chunk.files.length)] ?? history.steps[stepId];
      const historyText = historyEntry && typeof historyEntry.seconds === 'number'
        ? `  [历史 ${formatDuration(historyEntry.seconds * 1000)}${historyEntry.ok ? '' : ' · 上次失败'}]`
        : '';
      if (chunk.kind === KIND_SMOKE) {
        console.log(`    ${stepId}  npx electron ${chunk.files[0]}${historyText}`);
      } else {
        console.log(`    ${stepId}  ${chunk.kind === KIND_TSX ? 'npx tsx --test' : 'node --test'} ${chunk.files.length} 个文件${historyText}`);
        for (const file of chunk.files) {
          console.log(`        - ${file}`);
        }
      }
    }
  }
  console.log('');
  if (history.updatedAt !== null) {
    console.log(`历史耗时来源：${path.relative(FRONTEND_ROOT, DURATION_FILE)}（${history.updatedAt}）`);
  } else {
    console.log(`历史耗时：暂无（${path.relative(FRONTEND_ROOT, DURATION_FILE)} 尚未生成）`);
  }
  if (coverage.ok) {
    console.log(`覆盖自证：域场景（${SCENE_NAMES.filter((name) => name !== 'all').length} 组）并集 = ${coverage.totalMembers} 个成员 = 旧 test:all 成员全集，顺序一致。`);
  } else {
    console.log('覆盖自证：失败');
    for (const problem of coverage.problems) {
      console.log(`  - ${problem}`);
    }
  }
}

/**
 * 主流程：解析参数 → 自证 → 执行 → 汇总。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    console.error(USAGE_TEXT);
    return EXIT_USAGE;
  }

  if (options.help) {
    console.log(USAGE_TEXT);
    return EXIT_OK;
  }

  const coverage = verifySceneCoverage();
  if (!coverage.ok) {
    console.error('[ERROR] 分组配置自证失败（退出码 3），请修正 SCENES：');
    for (const problem of coverage.problems) {
      console.error(`  - ${problem}`);
    }
    return EXIT_CONFIG;
  }

  const history = await readDurationHistory();

  if (options.list) {
    printSceneList(history);
    return EXIT_OK;
  }

  const requestedScenes = options.scenes ?? (options.filter === null ? ['all'] : []);
  for (const sceneName of requestedScenes) {
    if (!SCENE_NAMES.includes(sceneName)) {
      console.error(`[ERROR] 未知场景组 "${sceneName}"`);
      console.error(`合法场景组：${SCENE_NAMES.join(' / ')}`);
      return EXIT_USAGE;
    }
  }

  const plan = [];
  if (options.filter !== null) {
    const keyword = options.filter.toLowerCase();
    for (const sceneName of SCENE_NAMES) {
      // `all` 只是其它场景的并集，参与过滤会让每个命中文件跑两遍，所以这里跳过它。
      if (sceneName === 'all') {
        continue;
      }
      for (const step of buildPlanForScene(sceneName, keyword)) {
        plan.push(step);
      }
    }
    if (plan.length === 0) {
      console.error(`[ERROR] --filter "${options.filter}" 没有命中任何测试文件`);
      return EXIT_USAGE;
    }
  } else {
    for (const sceneName of requestedScenes) {
      for (const step of buildPlanForScene(sceneName, null)) {
        plan.push(step);
      }
    }
  }

  const batchSteps = plan.filter((step) => step.kind !== KIND_SMOKE);
  const smokeSteps = plan.filter((step) => step.kind === KIND_SMOKE);
  const totalMembers = plan.reduce((total, step) => total + step.files.length, 0);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runLogDir = path.join(LOG_ROOT, runId);
  await ensureDir(runLogDir);
  const runStartedAt = Date.now();

  console.log('====== 前端测试 runner ======');
  console.log(`场景：${options.filter !== null ? `filter:"${options.filter}"` : requestedScenes.join(',')}`);
  console.log(`块：${batchSteps.length} 个批处理段 + ${smokeSteps.length} 个 electron smoke（共 ${totalMembers} 个测试文件）`);
  console.log(`electron 并发上限：${options.parallel}${options.parallel === 1 ? '（串行）' : ''}`);
  console.log(`失败策略：${options.failFast ? 'fail-fast（命中即中断）' : '聚合不中断（跑完全部再收口）'}`);
  console.log(`日志目录：${path.relative(FRONTEND_ROOT, runLogDir)}`);
  console.log('');

  const results = [];
  const state = { aborted: false, onFailure: null };
  if (options.failFast) {
    state.onFailure = () => true;
  }

  if (batchSteps.length > 0) {
    console.log('--- tsx / node 段（按其自身并行度串行执行，不与 electron 混跑）---');
    for (const step of batchSteps) {
      if (state.aborted) {
        break;
      }
      const result = await runStep(step, runLogDir);
      results.push(result);
      printResult(result);
      if (!result.ok && options.failFast) {
        state.aborted = true;
      }
    }
    console.log('');
  }

  if (smokeSteps.length > 0 && !state.aborted) {
    console.log(`--- electron smoke（并发 ${options.parallel}）---`);
    const smokeResults = await runWithLimit(smokeSteps, options.parallel, async (step) => {
      const result = await runStep(step, runLogDir);
      printResult(result);
      return result;
    }, state);
    results.push(...smokeResults);
    console.log('');
  }

  const stoppedByFailFast = state.aborted && results.length < plan.length;
  const failed = results.filter((result) => !result.ok);
  const passed = results.filter((result) => result.ok);
  const skipped = plan.length - results.length;
  const totalMs = results.reduce((total, result) => total + result.durationMs, 0);

  console.log('-------- 汇总 --------');
  const resultById = new Map(results.map((result) => [result.step.id, result]));
  for (const step of plan) {
    const result = resultById.get(step.id);
    if (result === undefined) {
      console.log(`[SKIP] ${step.id.padEnd(28, ' ')}        -  fail-fast 中断，未执行`);
      continue;
    }
    const label = result.ok ? '[PASS]' : '[FAIL]';
    const suffix = result.ok ? '' : `  ${result.reason}`;
    console.log(`${label} ${step.id.padEnd(28, ' ')} ${formatDuration(result.durationMs).padStart(8, ' ')}${suffix}`);
  }
  console.log('-----------------------');
  const summaryLine = `${passed.length} passed, ${failed.length} failed, ${skipped} skipped in ${formatDuration(totalMs)}（各块耗时合计；墙钟 ${formatDuration(Date.now() - runStartedAt)}）`;
  console.log(summaryLine);

  if (failed.length > 0) {
    console.log('');
    console.log('失败明细：');
    for (const result of failed) {
      console.log(`  - ${result.step.id}：${result.reason}`);
      console.log(`    命令：${buildCommandLine(result.step)}`);
      console.log(`    日志：${result.logPath}`);
      if (result.failureHints.length > 0) {
        console.log('    命中失败用例：');
        for (const hint of result.failureHints) {
          console.log(`      · ${hint}`);
        }
      }
      if (result.tail.length > 0) {
        console.log('    末尾输出：');
        for (const line of result.tail) {
          console.log(`      ${line}`);
        }
      }
    }
  }
  if (stoppedByFailFast) {
    console.log('（fail-fast 生效：剩余块未执行）');
  }

  const newEntries = {};
  for (const result of results) {
    newEntries[historyKeyFor(result.step.id, result.step.files.length)] = {
      seconds: Number((result.durationMs / 1000).toFixed(2)),
      ok: result.ok,
      at: new Date().toISOString(),
    };
  }
  await updateDurationHistory(newEntries);

  // 落盘本次运行的结构化记录（含每个块的起止时间），便于事后判断哪些块真的并行跑过。
  try {
    const summaryPayload = {
      scene: options.filter !== null ? `filter:${options.filter}` : requestedScenes.join(','),
      parallel: options.parallel,
      failFast: options.failFast,
      startedAt: new Date(runStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      totalMs,
      passed: passed.length,
      failed: failed.length,
      skipped,
      steps: results.map((result) => ({
        id: result.step.id,
        kind: result.step.kind,
        files: result.step.files,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt: new Date(result.startedAt).toISOString(),
        finishedAt: new Date(result.finishedAt).toISOString(),
        log: path.relative(FRONTEND_ROOT, result.logPath),
      })),
    };
    await fsp.writeFile(path.join(runLogDir, 'summary.json'), `${JSON.stringify(summaryPayload, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[WARN] summary.json 写入失败（不影响测试结论）：${error instanceof Error ? error.message : String(error)}`);
  }

  if (failed.length > 0) {
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

const exitCode = await main();
process.exitCode = exitCode;
