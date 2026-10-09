const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const modules = Promise.all([import('../scripts/framework-deps.mjs'), import('../scripts/build-backend.mjs')]);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-framework-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lingxi-framework-'));
    fs.rmSync(root, {recursive:true, force:true});
  });
  const remotes = {};
  const entries = {};
  for (const [id, artifact, version] of [['harness','lingXi-harness-agent','1.2.3'], ['ddd','dev-framework-ddd-helper','4.5.6']]) {
    const directory = path.join(root, 'remote-' + id);
    fs.mkdirSync(directory);
    const git = args => execFileSync('git', args, {cwd:directory, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
    git(['init']);
    fs.writeFileSync(path.join(directory, '.gitignore'), 'target/\n');
    const modules = id === 'harness' ? '<modules><module>harness-core</module></modules><properties><lingxi-harness.version>1.2.3</lingxi-harness.version></properties>' : '';
    fs.writeFileSync(path.join(directory, 'pom.xml'), `<project><groupId>io.github.yesnonononononi</groupId><artifactId>${artifact}</artifactId><version>${version}</version>${modules}</project>`);
    if (id === 'harness') {
      fs.mkdirSync(path.join(directory,'harness-core'));
      fs.writeFileSync(path.join(directory,'harness-core/pom.xml'), '<project><parent><version>1.2.3</version></parent><artifactId>harness-core</artifactId></project>');
    }
    fs.writeFileSync(path.join(directory, 'marker.txt'), 'locked source');
    git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','locked']);
    const ref = git(['rev-parse','HEAD']);
    // 远端分支继续推进，确保构建取得的是锁定提交。
    fs.writeFileSync(path.join(directory, 'marker.txt'), 'new branch head');
    git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','advance']);
    remotes[id] = directory;
    entries[id] = { repository:'fixture/' + id, ref, version };
  }
  const lock = {schemaVersion:1, frameworks:entries};
  fs.writeFileSync(path.join(root,'framework-deps.lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(root,'pom.xml'), '<project><properties><lingxi-starter>1.2.3</lingxi-starter><ddd-starter>4.5.6</ddd-starter></properties></project>');
  return {root, remotes, lock};
}

async function setup(t) {
  const [frameworks, backend] = await modules;
  const f = fixture(t);
  const calls = [];
  const options = {
    maven: {command:'fixture-maven',prefix:[]},
    checkout: (root,id,entry,options) => frameworks.checkoutFramework(root,id,entry,{...options,remote:f.remotes[id]}),
    runMaven: (_maven,args,cwd) => calls.push({args,cwd}),
  };
  return {...f, ...frameworks, ...backend, calls, options};
}

test('真实 Git 检出锁定提交，两个框架安装后业务使用同一隔离仓库', async t => {
  const f = await setup(t);
  const repository = f.buildBackend(f.root,'verify',f.options);
  assert.equal(f.calls.length,3);
  for (const call of f.calls) {
    assert.ok(call.args.includes('-Dmaven.repo.local=' + repository));
    assert.equal(call.cwd,f.root);
  }
  for (const call of f.calls.slice(0,2)) {
    assert.equal(call.args.at(-1),'install');
    assert.ok(call.args.includes('-Dgpg.skip=true'));
  }
  assert.equal(f.calls[2].args.at(-1),'verify');
  for (const [id,entry] of Object.entries(f.lock.frameworks)) {
    const directory = path.join(f.root,'.run/frameworks',id + '-' + entry.ref);
    assert.equal(fs.readFileSync(path.join(directory,'marker.txt'),'utf8'),'locked source');
  }
});

test('同版框架 SHA 改变后不能复用旧 Maven 仓库', async t => {
  const f = await setup(t);
  const first = f.buildBackend(f.root,'package',f.options);
  const ref = execFileSync('git',['rev-parse','HEAD'],{cwd:f.remotes.harness,encoding:'utf8'}).trim();
  f.updateFrameworkLock(f.root,'harness',ref,f.options);
  const second = f.buildBackend(f.root,'package',f.options);
  assert.notEqual(first,second);
  assert.ok(f.calls[5].args.includes('-Dmaven.repo.local=' + second));
});

test('框架安装失败必须终止业务构建', async t => {
  const f = await setup(t);
  const options = {...f.options,runMaven:(_maven,args) => { f.calls.push(args); throw new Error('framework failed'); }};
  assert.throws(()=>f.buildBackend(f.root,'package',options),/framework failed/);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].at(-1),'install');
});

test('版本、源码和子模块不一致时，在任何 Maven 调用前失败', async t => {
  const f = await setup(t);
  f.lock.frameworks.harness.version='1.2.4';
  fs.writeFileSync(path.join(f.root,'framework-deps.lock.json'),JSON.stringify(f.lock));
  assert.throws(()=>f.buildBackend(f.root,'package',f.options),/与业务 POM 不一致/);
  assert.equal(f.calls.length,0);
  assert.throws(()=>f.validateFrameworkSource(f.remotes.harness,'harness','1.2.4'),/源码版本不正确/);
  fs.writeFileSync(path.join(f.remotes.harness,'harness-core/pom.xml'),'<project><parent><version>1.0.0</version></parent></project>');
  assert.throws(()=>f.validateFrameworkSource(f.remotes.harness,'harness','1.2.3'),/子模块版本不一致/);
});

test('分支名不能作为锁定 SHA，缓存源码修改不能被覆盖', async t => {
  const f = await setup(t);
  f.buildBackend(f.root,'test',f.options);
  const entry=f.lock.frameworks.harness;
  const directory=path.join(f.root,'.run/frameworks','harness-' + entry.ref);
  fs.writeFileSync(path.join(directory,'marker.txt'),'local edit');
  assert.throws(()=>f.buildBackend(f.root,'test',f.options),/存在本地修改/);
  assert.equal(fs.readFileSync(path.join(directory,'marker.txt'),'utf8'),'local edit');
  entry.ref='main';
  fs.writeFileSync(path.join(f.root,'framework-deps.lock.json'),JSON.stringify(f.lock));
  assert.throws(()=>f.readFrameworkLock(f.root),/框架锁定项不正确/);
});

test('离线首次构建不联网；准备过的源码可离线复用且框架与业务均收到 -o', async t => {
  const f = await setup(t);
  assert.throws(()=>f.buildBackend(f.root,'test',{...f.options,offline:true}),/离线模式缺少锁定源码/);
  assert.equal(f.calls.length,0);
  f.buildBackend(f.root,'test',f.options);
  f.buildBackend(f.root,'test',{...f.options,offline:true});
  for (const call of f.calls.slice(3)) assert.ok(call.args.includes('-o'));
});

test('锁定更新失败时不改写原文件', async t => {
  const f=await setup(t);
  const before=fs.readFileSync(path.join(f.root,'framework-deps.lock.json'),'utf8');
  assert.throws(()=>f.updateFrameworkLock(f.root,'harness','0'.repeat(40),f.options),/框架源码操作失败/);
  assert.equal(fs.readFileSync(path.join(f.root,'framework-deps.lock.json'),'utf8'),before);
});

test('Release 与 Backend CI 使用统一源码构建入口', () => {
  const yaml=require('../node_modules/js-yaml');
  const release=yaml.load(fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/release.yml'),'utf8'));
  const ci=yaml.load(fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/backend-ci.yml'),'utf8'));
  const builds=steps=>steps.filter(step=>/npm run backend:/.test(step.run??''));
  assert.equal(builds([{run:'npm run backend:verify'}]).length,1,'入口扫描正对照');
  assert.equal(builds(release.jobs.release.steps)[0].run,'npm run backend:runtime');
  assert.equal(builds(ci.jobs.backend.steps)[0].run,'npm run backend:verify');
  assert.ok(ci.on.push.paths.includes('framework-deps.lock.json'));
  const runtime=fs.readFileSync(path.resolve(__dirname,'../scripts/build-backend-runtime.mjs'),'utf8');
  assert.match(runtime,/buildBackend\(repoRoot, 'package', \{ offline \}\)/);
});
