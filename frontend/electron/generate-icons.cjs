const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  try {
    const source = fs.readFileSync(path.join(__dirname, '../src/assets/lingxi-agent-logo.png'));
    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) throw new Error('产品 logo 无法解码');

    // ICO 条目尺寸必须与图片一致，否则 Windows 会回退到默认图标。
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
    const directory = Buffer.alloc(6 + sizes.length * 16);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(sizes.length, 4);
    let offset = directory.length;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      directory.writeUInt8(size === 256 ? 0 : size, entry);
      directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
      directory.writeUInt16LE(1, entry + 4);
      directory.writeUInt16LE(32, entry + 6);
      directory.writeUInt32LE(images[index].length, entry + 8);
      directory.writeUInt32LE(offset, entry + 12);
      offset += images[index].length;
    });
    fs.writeFileSync(path.join(__dirname, 'resources/icon.png'), source);
    fs.writeFileSync(path.join(__dirname, 'resources/icon.ico'), Buffer.concat([directory, ...images]));
    console.log(`产品图标已生成: sizes=${sizes.join(',')}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
