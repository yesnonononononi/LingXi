/**
 * 图像头解析（PNG / WebP）：只读文件头拿像素尺寸，不引图像库。
 *
 * <p><b>为什么要单独成一个模块：</b>门禁脚本、资产管线、测试三方都要用；如果放在
 * `check-pet-geometry.mjs` 里，`build-pet-assets.mjs` 就得反过来 import 它，而门禁又 import
 * 资产管线 —— 形成循环导入，ESM 下表现为 `Cannot access 'X' before initialization`（TDZ）。
 * 把"纯字节解析"抽到无依赖的最底层模块，依赖图就是单向的。</p>
 *
 * @module scripts/pet-image-headers
 */
import { readFileSync } from 'node:fs';

/**
 * 读 PNG 的 IHDR 拿真实宽高。
 *
 * @param {string} filePath PNG 路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readPngSize(filePath) {
  const buffer = readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${filePath} 不是合法 PNG（签名 ${signature}）`);
  }
  // IHDR 必须是第一个 chunk：8 字节签名 + 4 字节长度 + 4 字节类型 → 数据从第 16 字节开始
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') throw new Error(`${filePath} 第一个 chunk 不是 IHDR（实际 ${chunkType}）`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

/**
 * 读 WebP 的真实宽高（支持 VP8 有损 / VP8L 无损 / VP8X 扩展三种容器）。
 *
 * <p>自己解析头部而不是引依赖：门禁脚本要能在 CI 的裸 node 里跑，不该为了两个整数装图像库。</p>
 *
 * @param {string} filePath WebP 路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readWebpSize(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 30) throw new Error(`${filePath} 太小，不是合法 WebP`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error(`${filePath} 缺少 RIFF 头`);
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error(`${filePath} 缺少 WEBP 标识`);
  const chunk = buffer.subarray(12, 16).toString('ascii');

  if (chunk === 'VP8 ' || chunk === 'VP8L') {
    if (chunk === 'VP8L') {
      // 无损：1 字节签名 0x2f + 14bit 宽 + 14bit 高（都是「值 - 1」）
      if (buffer[20] !== 0x2f) throw new Error(`${filePath} 的 VP8L 签名非法`);
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        format: 'webp-lossless',
      };
    }
    // 有损：3 字节帧标签 + 3 字节起始码 9d 01 2a，随后 14bit 宽 + 14bit 高
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      throw new Error(`${filePath} 的 VP8 起始码非法`);
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      format: 'webp-lossy',
    };
  }
  if (chunk === 'VP8X') {
    // 扩展：4 字节标志 + 3 字节（宽-1） + 3 字节（高-1），小端
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height, format: 'webp-extended' };
  }
  throw new Error(`${filePath} 的 WebP chunk 类型未知：${chunk}`);
}

/**
 * 读任意支持格式的图片尺寸。
 *
 * @param {string} filePath 文件路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readImageSize(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return readPngSize(filePath);
  if (lower.endsWith('.webp')) return readWebpSize(filePath);
  throw new Error(`不认识的文件类型（只支持 png / webp）: ${filePath}`);
}
