/**
 * design_capture：按多个视口渲染 Design 画布的 PNG，供 Agent 做视觉自检。
 */

const {normalizeBoolean, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError, asToolError} = require('../errors.cjs');

module.exports = {
  name: 'design_capture',
  description: 'Capture rendered PNG screenshots of the active Design Canvas across one or more viewports (defaults to desktop 1280x800 and mobile 390x844) for visual self-check after editing.',
  inputSchema: {
    type: 'object',
    properties: {
      viewports: {
        type: 'array',
        description: 'Optional list of viewports to capture (max 4). Defaults to desktop (1280x800) and mobile (390x844).',
        items: {
          type: 'object',
          properties: {
            name: {type: 'string', description: 'Viewport label (e.g. "desktop", "tablet", "mobile").'},
            width: {type: 'integer', minimum: 320, maximum: 2560, description: 'Viewport width in pixels (320-2560).'},
            height: {type: 'integer', minimum: 400, maximum: 2400, description: 'Viewport height in pixels (400-2400).'},
          },
        },
      },
      fullPage: {type: 'boolean', description: 'Capture full scrollable height beyond the viewport. Defaults to false.'},
      saveDir: {type: 'string', description: 'Optional absolute directory path (e.g. inside the workspace) where the captured PNG screenshots will be saved. Missing directories are created automatically. If omitted, files are saved to a system temporary directory outside the workspace.'},
    },
  },

  async run(host, args) {
    const bridge = host.designBridge;
    if (!bridge) throw toolError(TOOL_ERROR.DESIGN_UNAVAILABLE, 'Design 画布桥接器未启用');
    let captured;
    try {
      captured = await bridge.capture({
        viewports: args.viewports,
        fullPage: normalizeBoolean(args.fullPage, false),
        saveDir: normalizeText(args.saveDir),
        saveToTemp: true,
      });
    } catch (error) {
      throw asToolError(TOOL_ERROR.DESIGN_UNAVAILABLE, error);
    }
    const shots = captured.shots || [];
    return {
      images: shots.map(shot => ({data: shot.base64, mimeType: shot.mimeType || 'image/png'})),
      fileName: captured.fileName,
      boundPath: captured.boundPath,
      shots: shots.map(shot => ({
        name: shot.name,
        width: shot.width,
        height: shot.height,
        filePath: shot.filePath,
        fullPageApplied: shot.fullPageApplied,
        fullPageTruncated: shot.fullPageTruncated,
      })),
    };
  },
};
