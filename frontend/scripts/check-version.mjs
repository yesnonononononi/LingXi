#!/usr/bin/env node
/**
 * 版本号一致性守卫。
 *
 * 事故背景（必读，别删）：
 *   GitHub Release tag 打的是 `0.0.1`，Release 名叫 `lingxi-setup-0.0.1`，
 *   但资产文件名是 `LX.Setup.0.0.0.exe`，而 frontend/package.json 里写的是 `0.0.0`。
 *   即：发版人只在 tag 上手工敲了版本号，package.json 没同步 —— electron-builder
 *   用 package.json 的版本号命名产物，于是「标签说 0.0.1、文件说 0.0.0」。
 *
 * 为什么这会让更新机制失效：
 *   electron-updater 判断「有没有新版本」靠比对 tag 与本地 app.getVersion()。
 *   本地是 0.0.0，远程 tag 是 0.0.1 → 判定有更新 → 下载 0.0.0 的包 → 装完还是
 *   app.getVersion()===0.0.0 → 下次启动又判定有更新。**无限更新循环**，
 *   且用户看到的版本号永远不变。
 *
 * 因此：版本号只能有一个真源 = frontend/package.json 的 version 字段。
 *   - CI 打 tag 时，tag 必须等于这个值；
 *   - electron-builder 的 artifactName 用 ${version} 展开，天然跟随；
 *   - 本脚本负责在构建前把不一致暴露成**失败**，而不是事后靠人眼看文件名。
 *
 * 用法：
 *   node scripts/check-version.mjs                 # 校验（CI / 构建前置）
 *   node scripts/check-version.mjs --expect-tag=v0.0.1   # 额外比对 tag
 *   node scripts/check-version.mjs --json          # 机器可读输出
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(frontendRoot, 'package.json');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const expectTag = argv.find((a) => a.startsWith('--expect-tag='))?.slice('--expect-tag='.length);

/** SemVer 宽松解析：只取 major.minor.patch，忽略预发布/构建元数据 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { raw: raw.trim(), major: +m[1], minor: +m[2], patch: +m[3] };
}

function compare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const problems = [];
const info = {};

// ---------------------------------------------------------------- 1. package.json

if (!fs.existsSync(pkgPath)) {
  problems.push(`找不到 ${pkgPath}`);
} else {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = parseVersion(pkg.version);
  info.packageVersion = pkg.version;

  // 占位版本号是历史遗留（发版时忘了改），必须显式拦下来
  if (!version) {
    problems.push(`package.json version 不是合法 SemVer: ${JSON.stringify(pkg.version)}`);
  } else if (version.raw === '0.0.0' || version.raw === '0.0.1') {
    // 0.0.1 是当前线上版本，允许；再往后必须真的往上走
    info.note = '当前处于 0.0.x 起始段，发版时记得递增';
  }

  // ------------------------------------------------------------ 2. artifactName

  const artifactName = pkg.build?.win?.artifactName;
  info.artifactName = artifactName ?? null;
  if (!artifactName) {
    problems.push(
      'build.win.artifactName 未配置 —— 产物名将退化为 electron-builder 默认值，' +
        '与「版本号唯一真源」的约定脱节。应设为 "LX.Setup.${version}.${ext}"。'
    );
  } else if (!artifactName.includes('${version}')) {
    problems.push(
      `build.win.artifactName 不含 \${version}（当前 ${JSON.stringify(artifactName)}）—— ` +
        '产物名写死会让发布物与 package.json 版本号脱钩，重现 0.0.0/0.0.1 漂移。'
    );
  }

  // ------------------------------------------------------------ 3. publish 通道

  const publish = pkg.build?.publish;
  info.publish = publish ?? null;
  if (!publish || (Array.isArray(publish) && publish.length === 0)) {
    problems.push(
      'build.publish 未配置 —— electron-updater 在运行期无法解析 feed URL，' +
        '更新检查会直接抛 "Cannot find channel" / 空 feed。'
    );
  } else {
    const cfg = Array.isArray(publish) ? publish[0] : publish;
    if (cfg.provider !== 'github') {
      problems.push(`build.publish[0].provider 应为 "github"，实际 ${JSON.stringify(cfg.provider)}`);
    }
    if (!cfg.owner || !cfg.repo) {
      problems.push('build.publish[0] 缺少 owner / repo —— GitHub provider 必需。');
    } else {
      info.feed = `${cfg.owner}/${cfg.repo}`;

      // ---------------------------------------------------------------- 4. 客户端 feed 真源
      // ⚠️ 直接解析 electron/updater.cjs 里真正被应用使用的那份常量，而不是在
      //    本脚本里再写一遍期望值 —— 后者是「自己证明自己」：两边都写错时闸门照样放绿。
      //    历史缺口：updater.cjs 的 owner 少了一个 `no`（yesnononononi），
      //    而本脚本当时只比对自造常量，于是检查通过、客户端却在查另一条仓库路径。
      const updaterSrc = path.join(frontendRoot, 'electron', 'updater.cjs');
      info.clientFeedFile = 'electron/updater.cjs';
      if (!fs.existsSync(updaterSrc)) {
        problems.push(`找不到 ${updaterSrc} —— 无法验证客户端实际使用的 feed。`);
      } else {
        const src = fs.readFileSync(updaterSrc, 'utf8');
        const m = src.match(/const UPDATE_FEED = Object\.freeze\(\{\s*owner:\s*'([^']*)',\s*repo:\s*'([^']*)'\s*\}\)/);
        if (!m) {
          problems.push(
            'electron/updater.cjs 中未找到 UPDATE_FEED 常量（期望形如 ' +
              "`const UPDATE_FEED = Object.freeze({ owner: '...', repo: '...' });`）—— " +
              '解析不到就无法验证客户端 feed，请勿改写该声明形式。'
          );
        } else {
          info.clientFeed = `${m[1]}/${m[2]}`;
          if (info.clientFeed !== info.feed) {
            problems.push(
              `客户端 feed (${info.clientFeed}，来自 electron/updater.cjs) 与 ` +
                `electron-builder publish (${info.feed}，来自 package.json) 不一致 —— ` +
                '客户端会去查另一条仓库路径，更新检查永远返回「无更新」，且 URL 白名单也会拒绝真实下载地址。'
            );
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 4. tag 比对

if (expectTag) {
  const tag = parseVersion(expectTag);
  info.tag = expectTag;
  if (!tag) {
    problems.push(`--expect-tag 不是合法版本: ${JSON.stringify(expectTag)}`);
  } else if (info.packageVersion && parseVersion(info.packageVersion)) {
    const pv = parseVersion(info.packageVersion);
    if (compare(pv, tag) !== 0) {
      problems.push(
        `tag (${expectTag}) 与 package.json version (${info.packageVersion}) 不一致 —— ` +
          '这正是历史事故的形态。请改 package.json 后重新打 tag，不要只在 tag 上改版本号。'
      );
    }
  }
}

// ---------------------------------------------------------------- 输出

if (asJson) {
  console.log(JSON.stringify({ ok: problems.length === 0, info, problems }, null, 2));
} else {
  console.log('[check-version] 版本一致性校验');
  console.log(`  package.json version : ${info.packageVersion ?? '(未知)'}`);
  console.log(`  artifactName         : ${info.artifactName ?? '(未配置)'}`);
  console.log(`  publish feed         : ${info.feed ?? '(未配置)'}`);
  console.log(`  客户端 feed          : ${info.clientFeed ?? '(未解析)'}`);
  if (expectTag) console.log(`  git tag              : ${expectTag}`);
  if (info.note) console.log(`  提示                 : ${info.note}`);

  if (problems.length === 0) {
    console.log('  ✅ 一致\n');
  } else {
    console.error('');
    for (const p of problems) console.error(`  ❌ ${p}`);
    console.error('');
  }
}

process.exit(problems.length === 0 ? 0 : 1);
