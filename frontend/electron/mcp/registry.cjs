/**
 * 内置浏览器 MCP 工具注册表。
 *
 *工具定义与执行在这里只登记一次，MCP 服务端（生成 tools/list）和自动机
 * （生成 automation 方法）都从这里读，双真源从根上消失。
 */

const browserNavigate = require('./tools/browser-navigate.cjs');
const browserClick = require('./tools/browser-click.cjs');
const browserFill = require('./tools/browser-fill.cjs');
const browserQuery = require('./tools/browser-query.cjs');
const browserScreenshot = require('./tools/browser-screenshot.cjs');
const browserTabs = require('./tools/browser-tabs.cjs');
const browserWait = require('./tools/browser-wait.cjs');
const browserScroll = require('./tools/browser-scroll.cjs');
const browserConsole = require('./tools/browser-console.cjs');
const browserNetwork = require('./tools/browser-network.cjs');
const browserNetworkDetail = require('./tools/browser-network-detail.cjs');
const browserEvaluate = require('./tools/browser-evaluate.cjs');
const browserPressKey = require('./tools/browser-press-key.cjs');

const designGetState = require('./tools/design-get-state.cjs');
const designCapture = require('./tools/design-capture.cjs');
const designResolveComment = require('./tools/design-resolve-comment.cjs');

/** 顺序即 tools/list 返回顺序，改动会改变模型看到的目录。 */
const BROWSER_TOOLS = Object.freeze([
  browserNavigate,
  browserClick,
  browserFill,
  browserQuery,
  browserScreenshot,
  browserTabs,
  browserWait,
  browserScroll,
  browserConsole,
  browserNetwork,
  browserNetworkDetail,
  browserEvaluate,
  browserPressKey,
]);

const DESIGN_TOOLS = Object.freeze([designGetState, designCapture, designResolveComment]);

/**
 * 列出当前可用的工具定义。
 *
 * @param includeDesign 是否带 Design 画布工具（桥接器未接线时不带）
 */
function listTools(includeDesign) {
  return includeDesign ? [...BROWSER_TOOLS, ...DESIGN_TOOLS] : [...BROWSER_TOOLS];
}

/** 按工具名取模块；找不到返回 undefined。 */
function findTool(name) {
  return listTools(true).find(tool => tool.name === name);
}

module.exports = {BROWSER_TOOLS, DESIGN_TOOLS, listTools, findTool};
