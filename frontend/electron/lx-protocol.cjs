/**
 * 桌宠资源的自定义协议 `lxa://`。
 *
 * <p><b>为什么必须有它：</b>桌宠页面是 `loadFile` 打开的，origin 是 `file://`，Chromium 会
 * **拒绝** `fetch('file://…')`。Live2D 的 `Live2DModel.from('…/model3.json')` 内部走 fetch，
 * 于是模型永远加载不出来，报错还指向网络层 —— 极容易被误判成「模型文件坏了」。自定义
 * 协议把资源变成同源可 fetch 的 URL，是接真模型的硬前提。</p>
 *
 * <p><b>路径形态：</b>`lxa://<模型目录>/<相对路径>`，即 host 当模型 id 用（standard scheme 会把
 * host 转小写，故模型目录名必须小写）。解析顺序：`userData/live2d/`（用户自装）→
 * `appPath/dist/live2d/`（内置，`public/live2d/` 经 Vite 复制进 `dist/`，打包时被
 * `electron-builder files: dist/**\/*` 自动打进 asar，打包配置零改动）。</p>
 *
 * <p><b>例外（生成型运行资产）：</b>host 为 `pet-poses` / `pet-sequences` 时**跳过**
 * `userData/live2d/`，只读内置根 —— 这两类资产由构建脚本从母版生成、并与清单逐个 sha256
 * 对上号，被同名目录影子覆盖属于静默降级（清单说一个字节，画面是另一个文件，而门禁全绿）。
 * 白名单见 {@link SHIPPED_ASSET_HOSTS}，其余 host 行为逐字节不变。</p>
 *
 * <p><b>安全边界（这是唯一能读本地文件的入口，必须钉死）：</b>目录穿越拦截、扩展名白名单、
 * 只返回文件不返回目录。渲染层即使被注入，也只能读到 live2d 目录下的几种资源。</p>
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 延迟取 electron 运行时（同其它模块：纯 node 下本文件的路径解析函数要能被单测）。
 */
function electron() {
  return require('electron');
}

/** 协议名。改这里等于改所有引用点，包括渲染层的模型 URL。 */
const LX_SCHEME = 'lxa';

/**
 * 允许读取的扩展名。
 *
 * <p>白名单而不是黑名单：允许任意扩展名等于把整个 live2d 目录（将来可能混入美术工程文件）
 * 全部暴露给渲染层。</p>
 */
const ALLOWED_EXTENSIONS = ['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav'];

/** 扩展名 → Content-Type。缺项时按二进制返回，让模型加载器自己判断。 */
const MIME_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
};

/**
 * **生成型**运行资产的 host 白名单（数组即事实：新增一种生成资产必须在这里登记）。
 *
 * <p><b>它守的是什么（而不是"顺手加个开关"）：</b>`lxa://<host>/<path>` 的 host 直接当目录名用，
 * 解析顺序一直是 `userData/live2d/`（用户自装）→ 内置 `dist/live2d/`。对**模型**来说这个顺序是对的
 * （用户有权覆盖自己装的模型）；但对 `pet-poses` / `pet-sequences` 这类
 * **由构建脚本从母版生成、并与清单逐个 sha256 对上号**的资产来说，被 `userData` 里的同名目录
 * 影子覆盖是一种静默降级：清单说"这帧是这个 sha256"，画面上却是另一个文件，而门禁全绿。</p>
 *
 * <p>所以对这几个 host：**只读内置根**（含开发态额外的 `public/live2d`），跳过 `userData` 影子。
 * 其余 host（用户模型目录）行为**逐字节不变**。</p>
 *
 * <p>`pet-v3` / `pet-p1` 暂不列入：它们是既有 Live2D 模型目录语义（用户可自装同名模型），
 * 本切片不改既有行为。若将来也要钉死，登记进这张表即可（一处生效）。</p>
 */
const SHIPPED_ASSET_HOSTS = Object.freeze(['pet-poses', 'pet-sequences']);

/**
 * 按 host 选出允许的解析根（纯函数，便于单测：不碰磁盘、不碰 electron）。
 *
 * @param {string} host URL host（standard scheme 已转小写）
 * @param {{user?: string[], builtin?: string[]}} groups 解析根分组
 * @returns {string[]} 解析根列表（按优先级）
 */
function selectBasesForHost(host, groups) {
  const user = Array.isArray(groups?.user) ? groups.user.filter((item) => typeof item === 'string' && item.length > 0) : [];
  const builtin = Array.isArray(groups?.builtin)
    ? groups.builtin.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const name = typeof host === 'string' ? host.toLowerCase() : '';
  // 生成型运行资产：只读内置根（用户目录里的同名目录**不许**影子覆盖）
  if (SHIPPED_ASSET_HOSTS.includes(name)) return [...builtin];
  return [...user, ...builtin];
}

/** 特权是否已登记（registerSchemesAsPrivileged 只能在 ready 之前调一次）。 */
let privilegesRegistered = false;

/**
 * 登记 `lxa://` 的协议特权。
 *
 * <p>**必须在 `app.whenReady()` 之前调用**，之后登记会抛异常且不生效。
 * `supportFetchAPI` 是让 `fetch()` 能用的关键；`standard` 让它有 host/path 结构；
 * `stream` 让大贴图按流返回，不必整块进内存。</p>
 */
function registerLxSchemePrivileges() {
  if (privilegesRegistered) return;
  const { protocol } = electron();
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LX_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
  privilegesRegistered = true;
}

/**
 * 把请求 URL 归一化成「模型目录/相对路径」。
 *
 * @param url 已解析的 URL 对象
 * @returns 归一化后的相对路径（posix 分隔符）；非法或可疑时返回 null
 */
function normalizeRequestPath(url) {
  if (!url || typeof url !== 'object') return null;
  const host = typeof url.host === 'string' ? url.host : '';
  const pathname = typeof url.pathname === 'string' ? url.pathname : '';
  let decoded = '';
  try {
    decoded = decodeURIComponent(`${host}${pathname}`);
  } catch {
    // 百分号编码非法（注入常见手法）：直接拒绝
    return null;
  }
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  // `.` / `..` 一律拒绝：URL 规范化之后仍可能出现，宁可 404 也不要依赖后面的 startsWith 兜底
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/**
 * 扩展名是否在白名单内。
 *
 * @param filePath 文件路径或文件名
 * @returns 是否允许读取
 */
function isAllowedAsset(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

/**
 * 取 Content-Type。
 *
 * @param filePath 文件路径
 * @returns MIME 字符串
 */
function mimeTypeFor(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 在某个根目录下解出候选路径（纯路径运算，不碰磁盘）。
 *
 * @param base 根目录
 * @param relative 归一化后的相对路径（posix 分隔符）
 * @returns 绝对路径；越过根目录或非白名单扩展名时返回 null
 */
function resolveCandidatePath(base, relative) {
  if (typeof base !== 'string' || base.length === 0) return null;
  if (typeof relative !== 'string' || relative.length === 0) return null;
  const root = path.resolve(base);
  const candidate = path.resolve(root, relative.split('/').join(path.sep));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  // 目录穿越防线：解出来的绝对路径必须仍在根目录之内
  if (!candidate.startsWith(prefix)) return null;
  if (!isAllowedAsset(candidate)) return null;
  return candidate;
}

/**
 * 依次在多个根目录里找一个真实存在的资源文件。
 *
 * @param relative 归一化后的相对路径
 * @param bases 根目录列表（按优先级）
 * @returns 命中的绝对路径；都不命中返回 null
 */
function resolveAssetPath(relative, bases) {
  const list = Array.isArray(bases) ? bases : [];
  for (const base of list) {
    const candidate = resolveCandidatePath(base, relative);
    if (!candidate) continue;
    try {
      // asar 内的文件 stat 同样可用，故打包后无需特殊处理
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * 构造一个 404 响应。
 *
 * @param reason 简短原因（写进 body，排障时能直接看出是「路径非法」还是「文件不存在」）
 * @returns Response
 */
function notFound(reason) {
  return new Response(`lxa 资源未找到: ${reason}`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 注册 `lxa://` 的请求处理器。
 *
 * <p>必须在 `app.whenReady()` 之后调用。</p>
 *
 * @param options.userDataDir 用户数据目录（用户自装模型放 `live2d/`）
 * @param options.appRoot 应用根目录（内置模型在 `dist/live2d/`）
 * @param options.extraBases 额外解析根（开发态把 `public/live2d` 放进来，否则 dev 下改素材必须
 *        先 build 一次才能被桌宠看到）
 * @returns 解析基准列表（排障用）
 */
function registerLxProtocol({ userDataDir, appRoot, extraBases }) {
  const { protocol } = electron();
  const extras = Array.isArray(extraBases) ? extraBases.filter((item) => typeof item === 'string' && item.length > 0) : [];
  // 分组而不是拍平：`selectBasesForHost` 要按 host 决定"能不能被 userData 影子覆盖"
  const baseGroups = {
    user: [path.join(String(userDataDir), 'live2d')],
    builtin: [...extras, path.join(String(appRoot), 'dist', 'live2d')],
  };
  const bases = selectBasesForHost('', baseGroups);

  protocol.handle(LX_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound('URL 非法');
    }
    const relative = normalizeRequestPath(url);
    if (!relative) return notFound('路径非法');
    // 生成型运行资产（pet-poses / pet-sequences）只许读内置根，其余 host 保持
    // `userData → 内置` 的既有优先级（用户自装模型可覆盖）
    const filePath = resolveAssetPath(relative, selectBasesForHost(url.host, baseGroups));
    if (!filePath) return notFound(`文件不存在或不在白名单: ${relative}`);
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mimeTypeFor(filePath),
          // 开发期会反复替换模型文件，缓存会让「换了贴图没变」；桌宠阶段资源量很小，不缓存更省心
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.warn(`[lxa] 资源读取失败: path=${filePath}, error=${(err && err.message) || err}`);
      return new Response('lxa 资源读取失败', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  });

  return { bases, scheme: LX_SCHEME };
}

module.exports = {
  registerLxSchemePrivileges,
  registerLxProtocol,
  normalizeRequestPath,
  resolveCandidatePath,
  resolveAssetPath,
  selectBasesForHost,
  isAllowedAsset,
  mimeTypeFor,
  LX_SCHEME,
  ALLOWED_EXTENSIONS,
  SHIPPED_ASSET_HOSTS,
};
