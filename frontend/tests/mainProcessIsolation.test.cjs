const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 主进程错误的用户可见性守卫。
 *
 * <p>Electron 在「除它自己以外没有任何 uncaughtException 监听器」时会弹一个
 * `A JavaScript error occurred in the main process` 原生框。agent 运行期驱动的一切
 * （浏览器自动化、网页预览、扩展包、图片动作）都在主进程里跑，那些报错属于内部错误，
 * 弹给用户纯属误导。所以：必须自己登记监听器，且兜底只记日志。</p>
 */

const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
const source = () => fs.readFileSync(mainPath, 'utf8');

test('主进程自己登记 uncaughtException（关掉 Electron 的默认错误框）', () => {
  assert.match(source(), /process\.on\('uncaughtException'/, '缺少 uncaughtException 兜底');
});

test('主进程自己登记 unhandledRejection', () => {
  assert.match(source(), /process\.on\('unhandledRejection'/, '缺少 unhandledRejection 兜底');
});

test('兜底通道只写日志，绝不许弹框', () => {
  const text = source();
  const start = text.indexOf("const logMainFailure =");
  const end = text.indexOf("process.on('unhandledRejection'");
  assert.ok(start > 0 && end > start, '兜底登记位置变了，用例需要同步更新锚点');

  const block = text.slice(start, end);
  assert.match(block, /mainLogPath/, '兜底必须落到 main.log 便于事后排查');
  assert.doesNotMatch(block, /showErrorBox|showMessageBox/, '内部错误不得走用户弹窗通道');
  // 日志文件必须挂在 userData 下（安装目录不可写）
  assert.match(text, /const mainLogPath = path\.join\(userDataDir, 'logs', 'main\.log'\)/);
});
