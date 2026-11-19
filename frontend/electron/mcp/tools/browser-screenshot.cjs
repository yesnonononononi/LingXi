/**
 * browser_screenshot：截当前标签页的 PNG。
 *
 *默认按标准桌面视口（1280x800）渲染，避免预览面板很窄时截出一张缩水图；
 * 需要真实面板宽度时传 viewportWidth: 0。
 */

const {normalizeBoolean, normalizeInt, normalizeText} = require('../args.cjs');

const MAX_DIMENSION = 4096;
const DEFAULT_VIEWPORT = Object.freeze({width: 1280, height: 800});

module.exports = {
  name: 'browser_screenshot',
  method: 'screenshot',
  description: 'Capture a PNG screenshot of the current built-in browser tab. By default, renders at a standard desktop viewport (1280x800) regardless of the preview panel width.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
      maxWidth: {type: 'integer', minimum: 1, maximum: MAX_DIMENSION, description: 'Resize width cap in pixels. Defaults to 1280.'},
      viewportWidth: {type: 'integer', minimum: 0, maximum: MAX_DIMENSION, description: 'Logical viewport width in pixels during capture (defaults to 1280). Pass 0 to use the current preview panel viewport.'},
      viewportHeight: {type: 'integer', minimum: 1, maximum: MAX_DIMENSION, description: 'Logical viewport height in pixels during capture (defaults to 800).'},
      fullPage: {type: 'boolean', description: 'Capture the full scrollable page beyond the viewport. Defaults to false.'},
      savePath: {type: 'string', description: 'Optional absolute PNG file path (e.g. inside the workspace) where the screenshot should be saved. Missing parent directories are created automatically. If omitted, the image is saved to a system temporary directory outside the workspace — pass savePath directly whenever you want to save or deliver the screenshot in the workspace instead of copying it afterward.'},
    },
  },

  async run(host, args) {
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const captureOptions = {
      maxWidth: normalizeInt(args.maxWidth, {fallback: DEFAULT_VIEWPORT.width, min: 1, max: MAX_DIMENSION}),
      viewportWidth: normalizeInt(args.viewportWidth, {fallback: DEFAULT_VIEWPORT.width, min: 0, max: MAX_DIMENSION}),
      viewportHeight: normalizeInt(args.viewportHeight, {fallback: DEFAULT_VIEWPORT.height, min: 1, max: MAX_DIMENSION}),
      fullPage: normalizeBoolean(args.fullPage, false),
    };

    return host.withAgentControl(tab, async () => {
      const shot = await host.captureScreenshot(tab, captureOptions);
      const filePath = await host.saveScreenshot(shot.buffer, normalizeText(args.savePath));
      return {
        images: [{data: shot.buffer.toString('base64'), mimeType: 'image/png'}],
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        width: shot.width,
        height: shot.height,
        filePath,
      };
    });
  },
};
