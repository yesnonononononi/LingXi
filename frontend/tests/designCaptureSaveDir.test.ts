import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const requireCjs = createRequire(import.meta.url);
const {registerDesignMcpBridge, DESIGN_MCP_CHANNELS} = requireCjs('../electron/design-mcp-bridge.cjs');

function createBridge(renderCalls: Array<{width: number; height: number}> = []) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, req: {requestId: string; action: string}) => {
        assert.equal(channel, DESIGN_MCP_CHANNELS.request);
        const respond = listeners.get(DESIGN_MCP_CHANNELS.response);
        assert.ok(respond);
        respond({}, {
          requestId: req.requestId,
          ok: true,
          data: {
            active: true,
            fileName: 'landing.html',
            boundPath: '.lingxi/design/landing.html',
            html: '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>',
          },
        });
      },
    },
  };
  return registerDesignMcpBridge({
    ipcMain: {
      on: (channel: string, fn: (...args: unknown[]) => void) => listeners.set(channel, fn),
      removeListener: (channel: string) => listeners.delete(channel),
    },
    getWindow: () => window,
    renderHtmlViewport: async ({width, height}: {width: number; height: number}) => {
      renderCalls.push({width, height});
      return {
        width,
        height,
        mimeType: 'image/png',
        base64: 'iVBORw0KGgo=',
        pngBuffer: Buffer.from('iVBORw0KGgo=', 'base64'),
        fullPageApplied: height > 800,
        fullPageTruncated: false,
      };
    },
  });
}

test('design_capture：saveDir 只收绝对路径，落盘到指定目录', async () => {
  const bridge = createBridge();
  await assert.rejects(() => bridge.capture({saveDir: 'relative/shots'}), /saveDir 必须是绝对路径/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-design-save-'));
  try {
    const nested = path.join(tempDir, 'nested', 'shots');
    const captured = await bridge.capture({
      viewports: [{name: 'desktop', width: 1280, height: 800}],
      saveDir: nested,
    });
    assert.equal(captured.shots.length, 1);
    const filePath = captured.shots[0].filePath as string;
    assert.ok(filePath.startsWith(nested), `落盘路径不在 saveDir 下: ${filePath}`);
    assert.equal(fs.existsSync(filePath), true, '异步写盘没写出文件');
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
});

test('design_capture：fullPage 透传给渲染器，并把全页结果回给模型', async () => {
  const renderCalls: Array<{width: number; height: number}> = [];
  const fullPageCalls: boolean[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, req: {requestId: string}) => {
        const respond = listeners.get(DESIGN_MCP_CHANNELS.response);
        assert.ok(respond);
        respond({}, {
          requestId: req.requestId,
          ok: true,
          data: {active: true, fileName: 'landing.html', html: '<html><body>tall</body></html>'},
        });
      },
    },
  };
  const bridge = registerDesignMcpBridge({
    ipcMain: {
      on: (channel: string, fn: (...args: unknown[]) => void) => listeners.set(channel, fn),
      removeListener: (channel: string) => listeners.delete(channel),
    },
    getWindow: () => window,
    renderHtmlViewport: async ({width, height, fullPage}: {width: number; height: number; fullPage: boolean}) => {
      renderCalls.push({width, height});
      fullPageCalls.push(fullPage);
      const appliedHeight = fullPage ? 3200 : height;
      return {
        width,
        height: appliedHeight,
        mimeType: 'image/png',
        base64: 'iVBORw0KGgo=',
        pngBuffer: Buffer.from('iVBORw0KGgo=', 'base64'),
        fullPageApplied: fullPage,
        fullPageTruncated: false,
      };
    },
  });

  const captured = await bridge.capture({viewports: [{name: 'desktop', width: 1280, height: 800}], fullPage: true});
  assert.deepEqual(fullPageCalls, [true]);
  assert.equal(captured.shots[0].height, 3200);
  assert.equal(captured.shots[0].fullPageApplied, true);
  assert.equal(captured.shots[0].fullPageTruncated, false);
});
