/**
 * 页面脚本的加载与注入。
 *
 *页面脚本住在 electron/page-scripts/*.js，是真文件而不是模板字符串：能被编辑器
 * 解析、能被单测、反斜杠回到正常层数。注入方式是把 common.js 和脚本体拼成一个 IIFE，
 * 参数经 JSON 序列化传入，避免字符串拼接注入。
 */

const fs = require('node:fs');
const path = require('node:path');

const PAGE_SCRIPT_DIR = path.join(__dirname, '..', 'page-scripts');
const COMMON_FILE = 'common.js';

const bodyCache = new Map();
let commonSource = '';

/** 读入公共件（只需一次）。 */
function loadCommon() {
  if (!commonSource) {
    commonSource = fs.readFileSync(path.join(PAGE_SCRIPT_DIR, COMMON_FILE), 'utf8');
  }
  return commonSource;
}

/** 读入脚本体并缓存。 */
function loadBody(name) {
  if (!bodyCache.has(name)) {
    bodyCache.set(name, fs.readFileSync(path.join(PAGE_SCRIPT_DIR, `${name}.js`), 'utf8'));
  }
  return bodyCache.get(name);
}

/** 序列化参数；U+2028/U+2029 是 JS 字符串字面量里的坑，显式转义。 */
function serializeArgs(args) {
  return JSON.stringify(args)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 拼出可直接丢给 executeJavaScript 的脚本。
 *
 * @param name 页面脚本名（不带扩展名）
 * @param args 传给脚本的参数对象
 * @returns 完整脚本文本
 */
function buildPageScript(name, args = {}) {
  // 必须是 async IIFE：evaluate.js 要 await 用户在页面里给的 Promise，非 async 会直接语法错
  return `(async function (args) {\n${loadCommon()}\n${loadBody(name)}\n})(${serializeArgs(args)})`;
}

/**
 * 在标签页里执行页面脚本。
 *
 * @param contents WebContents
 * @param name 页面脚本名
 * @param args 参数
 * @returns 脚本返回值
 */
async function runPageScript(contents, name, args = {}) {
  if (!contents || contents.isDestroyed() || typeof contents.executeJavaScript !== 'function') {
    throw new Error('当前网页标签不可执行脚本');
  }
  return contents.executeJavaScript(buildPageScript(name, args), true);
}

module.exports = {PAGE_SCRIPT_DIR, buildPageScript, runPageScript};
