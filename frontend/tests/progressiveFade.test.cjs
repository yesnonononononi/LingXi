const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('真实 Markdown 流式渐进淡入兼容生命周期、代码与动态偏好', { timeout: 120000 }, async () => {
  const result = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'progressiveFade.smoke.cjs')], { env, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
});
