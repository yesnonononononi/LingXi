const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');

test('真实 thinking 组件分帧调度兼容复制、滚动与生命周期', {timeout:120000}, async () => {
  const result = await new Promise((resolve,reject)=>{
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'),[path.join(__dirname,'thinkingText.smoke.cjs')],{env,windowsHide:true});
    let output=''; child.stdout.on('data',data=>output+=data); child.stderr.on('data',data=>output+=data);
    child.on('error',reject); child.on('exit',code=>resolve({code,output}));
  });
  assert.equal(result.code,0,result.output);
});
