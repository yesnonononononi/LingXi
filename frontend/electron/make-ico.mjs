import fs from 'fs';
import path from 'path';

const srcPng = path.resolve('src/assets/lingxi-agent-logo.png');
const destPng = path.resolve('electron/resources/icon.png');
const destIco = path.resolve('electron/resources/icon.ico');

// 1. 复制为 icon.png (用于窗口运行时图标和 Linux 图标)
const pngBuffer = fs.readFileSync(srcPng);
fs.writeFileSync(destPng, pngBuffer);

// 2. 构造标准 Windows PNG-embedded ICO 格式文件
// 头部 6 字节: Reserved(2) + Type(2=ICO) + Count(2=1)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

// 目录项 16 字节: Width(1), Height(1), Colors(1), Reserved(1), Planes(2), BitCount(2), Size(4), Offset(4)
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);       // 0 代表 256px
entry.writeUInt8(0, 1);       // 0 代表 256px
entry.writeUInt8(0, 2);       // color count
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // color planes
entry.writeUInt16LE(32, 6);   // bit count
entry.writeUInt32LE(pngBuffer.length, 8); // image size in bytes
entry.writeUInt32LE(22, 12);  // offset = 6 + 16 = 22

const icoBuffer = Buffer.concat([header, entry, pngBuffer]);
fs.writeFileSync(destIco, icoBuffer);

console.log('成功生成 icon.ico 和 icon.png 到 electron/resources/ 目录！');
