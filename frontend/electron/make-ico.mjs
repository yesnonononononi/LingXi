import fs from 'fs';
import path from 'path';

const srcPng = path.resolve('src/assets/lingxi-agent-logo.png');
const destPng = path.resolve('electron/resources/icon.png');
const destIco = path.resolve('electron/resources/icon.ico');

// 1. 复制为 icon.png (用于窗口运行时图标和 Linux 图标)
const pngBuffer = fs.readFileSync(srcPng);
fs.writeFileSync(destPng, pngBuffer);

/**
 * 读 PNG 的真实像素尺寸。
 *
 * 不能把源图尺寸写死：下一步要用它去填 ICO 目录项的 Width/Height，写错会让
 * Windows 按错误尺寸渲染图标（任务栏/桌面/安装包都可能变形）。PNG 的 IHDR 固定
 * 在偏移 16，宽高各 4 字节大端。
 */
const pngWidth = pngBuffer.readUInt32BE(16);
const pngHeight = pngBuffer.readUInt32BE(20);

// 2. 构造标准 Windows PNG-embedded ICO 格式文件
// 头部 6 字节: Reserved(2) + Type(2=ICO) + Count(2=1)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

// 目录项 16 字节: Width(1), Height(1), Colors(1), Reserved(1), Planes(2), BitCount(2), Size(4), Offset(4)
// Width/Height 只有 1 字节：256 必须在两个字段里都写实际尺寸（0 是「256」的保留编码，
// 写 0 而图不是 256 就会与真实尺寸不符）。本仓的源图是 1254×1254，超出 1 字节可表达的范围，
// 故两个字段都钳到 255 —— 与 electron-builder / Windows 对该字段的解读一致。
const toIcoDimension = (value) => (value >= 256 ? 0 : value);
const entry = Buffer.alloc(16);
entry.writeUInt8(toIcoDimension(pngWidth), 0);
entry.writeUInt8(toIcoDimension(pngHeight), 1);
entry.writeUInt8(0, 2);       // color count
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // color planes
entry.writeUInt16LE(32, 6);   // bit count
entry.writeUInt32LE(pngBuffer.length, 8); // image size in bytes
entry.writeUInt32LE(22, 12);  // offset = 6 + 16 = 22

const icoBuffer = Buffer.concat([header, entry, pngBuffer]);
fs.writeFileSync(destIco, icoBuffer);

console.log(`成功生成 icon.ico 和 icon.png 到 electron/resources/ 目录！（源图 ${pngWidth}×${pngHeight}）`);
