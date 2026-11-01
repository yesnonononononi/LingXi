const { fs, path, root, sharp, W, H, parts, image, writeJson, readRaw, over } = require('./common.cjs');
async function native(file) {
  const data = await readRaw(file), result = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const offset = (y * 2 * W * 2 + x * 2) * 4;
    data.copy(result, (y * W + x) * 4, offset, offset + 4);
  }
  return result;
}
function move(data, dx, dy, angle = 0, pivot = [0, 0]) {
  const result = Buffer.alloc(data.length), radians = angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x - dx - pivot[0], v = y - dy - pivot[1];
    const sx = Math.round(c * u + s * v + pivot[0]), sy = Math.round(-s * u + c * v + pivot[1]);
    if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
    const source = (sy * W + sx) * 4;
    data.copy(result, (y * W + x) * 4, source, source + 4);
  }
  return result;
}
async function label(text, width, dark) {
  return sharp(Buffer.from(`<svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg"><text x="${width / 2}" y="27" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="17" fill="${dark ? '#e9e3ec' : '#51464e'}">${text}</text></svg>`)).png().toBuffer();
}
async function main() {
  const base = await readRaw('source/reference-p0-native.png');
  const reconstructed = await native('support/reconstructed.png');
  const layers = new Map();
  for (const part of parts) layers.set(part.id, await native(`${part.id}.png`));
  const underpainting = await native('support/underpainting.png'), body = await native('support/body-occluder.png'), foreground = await native('support/foreground-occluder.png');
  function scene(target, dx, dy, angle = 0) {
    const result = Buffer.from(underpainting);
    for (const id of ['01_tail_base', '02_tail_tip', '03_ear_left', '04_ear_right']) {
      const part = parts.find(item => item.id === id);
      over(result, target === id ? move(layers.get(id), dx, dy, angle, part.pivot) : layers.get(id));
    }
    over(result, body);
    for (const id of ['05_ahoge', '06_bow']) {
      const part = parts.find(item => item.id === id);
      over(result, target === id ? move(layers.get(id), dx, dy, angle, part.pivot) : layers.get(id));
    }
    over(result, foreground);
    return result;
  }
  const overview = [], pieces = [], offsets = [], negativeOffsets = [];
  for (let row = 0; row < 2; row++) {
    const dark = row === 1, bg = dark ? '#1a1a2e' : '#f5f5f7';
    for (let col = 0; col < 2; col++) {
      const rendered = await image(col ? reconstructed : base).resize(320,480).flatten({ background: bg }).png().toBuffer();
      const title = await label(col ? 'P1 六件重组' : 'P0 原立绘', 360, dark);
      const cell = await sharp({ create: { width: 360, height: 535, channels: 4, background: bg } })
        .composite([{ input: rendered, left: 20, top: 42 }, { input: title, left: 0, top: 0 }]).png().toBuffer();
      overview.push({ input: cell, left: col * 360, top: row * 535 });
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], [left, top, right, bottom] = part.roi;
      const width = right - left + 1, height = bottom - top + 1;
      const graphic = await image(layers.get(part.id)).extract({ left, top, width, height }).resize(320,320,{fit:'contain',background:bg}).flatten({background:bg}).png().toBuffer();
      const title = await label(`${part.id.slice(0,2)} ${part.label}`, 360, dark);
      const cell = await sharp({create:{width:360,height:370,channels:4,background:bg}})
        .composite([{input:graphic,left:20,top:42},{input:title,left:0,top:0}]).png().toBuffer();
      pieces.push({input:cell,left:(i%3)*360,top:(Math.floor(i/3)+row*2)*370});
      for (const [direction, destination] of [[1, offsets], [-1, negativeOffsets]]) {
        const shifted = scene(part.id, direction * 5, direction * 5);
        const crop = await image(shifted).extract({left,top,width,height}).resize(320,320,{fit:'contain',background:bg}).flatten({background:bg}).png().toBuffer();
        const titleShift = await label(`${part.id.slice(0,2)} ${direction>0?'+10': '-10'}px X/Y`, 360, dark);
        const cellShift = await sharp({create:{width:360,height:370,channels:4,background:bg}})
          .composite([{input:crop,left:20,top:42},{input:titleShift,left:0,top:0}]).png().toBuffer();
        destination.push({input:cellShift,left:(i%3)*360,top:(Math.floor(i/3)+row*2)*370});
      }
    }
  }
  await sharp({create:{width:720,height:1070,channels:4,background:'#f5f5f7'}}).composite(overview).png().toFile(path.join(root,'preview.png'));
  for (const [file,cells] of [['qa/parts-light-dark.png',pieces],['qa/offset-positive-10px.png',offsets],['qa/offset-negative-10px.png',negativeOffsets]]) {
    await sharp({create:{width:1080,height:1480,channels:4,background:'#f5f5f7'}}).composite(cells).png().toFile(path.join(root,file));
  }
  const rotations = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], angle = part.id.includes('ear') ? 4 : part.id.includes('tail') ? 1 : 3;
    const moved = scene(part.id,0,0,angle),[left,top,right,bottom]=part.roi;
    const picture = await image(moved).extract({left,top,width:right-left+1,height:bottom-top+1}).resize(320,320,{fit:'contain',background:'#1a1a2e'}).flatten({background:'#1a1a2e'}).png().toBuffer();
    const title = await label(`${part.id.slice(0,2)} 旋转 ${angle}°`,360,true);
    const cell = await sharp({create:{width:360,height:370,channels:4,background:'#1a1a2e'}}).composite([{input:picture,left:20,top:42},{input:title,left:0,top:0}]).png().toBuffer();
    rotations.push({input:cell,left:index%3*360,top:Math.floor(index/3)*370});
  }
  await sharp({create:{width:1080,height:740,channels:4,background:'#1a1a2e'}}).composite(rotations).png().toFile(path.join(root,'qa/rotation-check.png'));
  console.log('已输出重组对照、独立部件、双向偏移和旋转截图');
}
module.exports={native,move};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
