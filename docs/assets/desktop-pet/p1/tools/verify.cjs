const assert = require('node:assert/strict');
const { fs, path, root, sharp, W, H, parts, image, hash, writeJson, readRaw, over } = require('./common.cjs');
const { native, move } = require('./preview.cjs');
const { P0_SHA256, supportLayers, checkReference, checkRegisteredAsset } = require('./contract.cjs');

function checkHeader(buffer) {
  assert.equal(buffer.subarray(0,8).toString('hex'),'89504e470d0a1a0a','PNG 签名错误');
  assert.equal(buffer.readUInt32BE(16),2048,'宽度必须为 2048');
  assert.equal(buffer.readUInt32BE(20),3072,'高度必须为 3072');
  assert.equal(buffer[24],8,'必须为 8bit');assert.equal(buffer[25],6,'必须为 RGBA');
  let profile=false;
  for(let offset=8;offset+12<=buffer.length;){
    const length=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8);
    assert.ok(offset+length+12<=buffer.length,'PNG 块越界');
    if(['tEXt','iTXt','zTXt'].includes(type))assert.fail('不允许文本元数据块');
    if(type==='sRGB'||type==='iCCP')profile=true;
    offset+=length+12;
  }
  assert.ok(profile,'缺少色彩空间声明');
}
function checkEdges(data) {
  for(let x=0;x<2048;x++)assert.ok(!data[x*4+3]&&!data[((3072-1)*2048+x)*4+3],'上下边缘不透明');
  for(let y=0;y<3072;y++)assert.ok(!data[y*2048*4+3]&&!data[(y*2048+2047)*4+3],'左右边缘不透明');
}
function checkInventory(manifest,files) {
  const expected=['01_tail_base.png','02_tail_tip.png','03_ear_left.png','04_ear_right.png','05_ahoge.png','06_bow.png'];
  assert.deepEqual(manifest.files.filter(item=>item.kind==='part').map(item=>item.file),expected,'六件清单不完整');
  assert.deepEqual(manifest.files.filter(item=>item.kind==='support').map(item=>item.file),supportLayers.map(item=>item.file),'支撑层清单不完整');
  const registered=manifest.files.map(item=>item.file);
  assert.equal(new Set(registered).size,registered.length,'清单文件重复');
  assert.equal(manifest.files.length,9,'清单必须登记六个部件和三个支撑层');
  assert.equal(new Set(manifest.renderOrder).size,manifest.renderOrder.length,'渲染顺序存在重复文件');
  assert.deepEqual([...manifest.renderOrder].sort(),[...registered].sort(),'渲染顺序存在未登记或遗漏的文件');
  assert.deepEqual(manifest.canvas,{width:2048,height:3072});assert.deepEqual(manifest.anchor,{x:1024,y:2908});
  for(const item of manifest.files){
    assert.ok(files.includes(item.file),`缺少 ${item.file}`);
    assert.ok(item.purpose&&item.width===2048&&item.height===3072&&/^[a-f0-9]{64}$/.test(item.sha256),'清单缺少用途、尺寸或摘要');
    if(item.kind==='support')continue;
    assert.match(item.file,/^\d{2}_[a-z_]+\.png$/,'部件命名错误');
    assert.ok(item.purpose&&item.occlusionFill&&item.pivot&&item.visibleMask&&item.hiddenMask,'部件信息不完整');
    assert.ok(!item.mirrored,'不允许镜像凑右耳');
  }
  for(const file of files)assert.match(file,/^[\x20-\x7e]+$/,'资源路径不是 ASCII');
  for(const file of files)if(/^\d{2}_.*\.png$/.test(file))assert.ok(expected.includes(file),'存在未登记部件');
}
function walk(directory,prefix=''){
  const result=[];
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name==='.git')continue;
    if(entry.isDirectory())result.push(...walk(path.join(directory,entry.name),prefix+entry.name+'/'));
    else result.push(prefix+entry.name);
  }
  return result;
}
function assertVisiblePixels(layer,mask,base){
  for(let i=0;i<W*H;i++)if(mask[i*4+3])assert.equal(Buffer.compare(layer.subarray(i*4,i*4+4),base.subarray(i*4,i*4+4)),0,'原图可见像素发生变化');
}
function countDifferences(a,b){let rgba=0,alpha=0;for(let i=0;i<a.length;i+=4){if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])rgba++;if(a[i+3]!==b[i+3])alpha++;}return{rgba,alpha};}

async function main(){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const files=walk(root),header=fs.readFileSync(path.join(root,parts[0].id+'.png'));
  const badHeader=Buffer.from(header);badHeader[25]=3;assert.throws(()=>checkHeader(badHeader),/RGBA/);
  const text=Buffer.concat([Buffer.from([0,0,0,6]),Buffer.from('tEXt'),Buffer.from([0,0xe4,0xb8,0xad,0,0]),Buffer.alloc(4)]);
  assert.throws(()=>checkHeader(Buffer.concat([header.subarray(0,33),text,header.subarray(33)])),/文本元数据/);
  const missing=structuredClone(manifest);missing.files=missing.files.filter(item=>item.file!=='06_bow.png');assert.throws(()=>checkInventory(missing,files),/清单/);
  assert.throws(()=>checkInventory(manifest,[...files,'07_unknown.png']),/未登记部件/);
  checkInventory(manifest,files);
  checkReference(manifest.reference);
  assert.throws(()=>checkReference({...manifest.reference,sha256:'pending'}),/基准摘要未锁定/);
  const originalReference=fs.readFileSync(manifest.reference.path),changedReference=Buffer.from(originalReference);
  changedReference[changedReference.length-1]^=1;
  assert.throws(()=>checkReference(manifest.reference,()=>changedReference),/立绘内容已改变/);
  const supportChecks=[];
  for(const record of manifest.files){
    const bytes=checkRegisteredAsset(record);checkHeader(bytes);checkEdges(await readRaw(record.file));
    if(record.kind!=='support')continue;
    const incomplete=structuredClone(manifest);incomplete.files=incomplete.files.filter(item=>item.file!==record.file);
    assert.throws(()=>checkInventory(incomplete,files),/支撑层清单/);
    assert.throws(()=>checkInventory(manifest,files.filter(file=>file!==record.file)),/缺少/);
    assert.throws(()=>checkRegisteredAsset(record,()=>{const error=new Error('金丝雀缺失文件');error.code='ENOENT';throw error;}),/必需美术资源缺失/);
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    assert.throws(()=>checkRegisteredAsset(record,()=>changed),/资源摘要不一致/);
    const wrongWidth=Buffer.from(bytes);wrongWidth.writeUInt32BE(2047,16);
    assert.throws(()=>checkRegisteredAsset(record,()=>wrongWidth),/实际宽度/);
    supportChecks.push({file:record.file,width:record.width,height:record.height,sha256:record.sha256,missingFileRejected:true,missingRegistrationRejected:true,changedBytesRejected:true,changedDimensionsRejected:true});
  }
  const base=await readRaw('source/reference-p0-native.png'),layers=new Map(),details=[];
  let totalBytes=0;
  for(const record of manifest.files.filter(record=>record.kind==='part')){
    const buffer=fs.readFileSync(path.join(root,record.file));checkHeader(buffer);
    assert.equal(hash(record.file),record.sha256,'摘要不一致');assert.ok(buffer.length<=2*1024*1024,'单部件超过 2MiB');totalBytes+=buffer.length;
    const full=await readRaw(record.file);checkEdges(full);
    const badEdge=Buffer.from(full);badEdge[3]=255;assert.throws(()=>checkEdges(badEdge),/边缘/);
    const layer=await native(record.file),visible=await native(record.visibleMask),hidden=await native(record.hiddenMask);
    assertVisiblePixels(layer,visible,base);
    const mutated=Buffer.from(layer),firstVisible=visible.findIndex((value,index)=>index%4===3&&value>0)-3;
    assert.ok(firstVisible>=0);mutated[firstVisible]^=1;assert.throws(()=>assertVisiblePixels(mutated,visible,base),/可见像素/);
    let visibleCount=0,hiddenCount=0,left=W,top=H,right=0,bottom=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const offset=(y*W+x)*4;
      if(visible[offset+3])visibleCount++;
      if(hidden[offset+3]){hiddenCount++;assert.equal(layer[offset+3],255,'补绘区域没有覆盖');}
      if(!layer[offset+3])continue;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      const [minX,minY,maxX,maxY]=record.allowedRegion;
      assert.ok(x*2>=minX&&x*2<=maxX&&y*2>=minY&&y*2<=maxY,'部件像素越出合理位置');
    }
    assert.ok(visibleCount>1000,'部件可见内容不足');assert.ok(hiddenCount>100,'缺少遮挡补绘');
    assert.equal(visibleCount,record.visiblePixelsNative);assert.equal(hiddenCount,record.hiddenPixelsNative);
    layers.set(record.id,layer);details.push({id:record.id,visiblePixelsNative:visibleCount,hiddenPixelsNative:hiddenCount,boundsNative:[left,top,right,bottom],pivot:record.pivot});
  }
  const underpaint=await native('support/underpainting.png'),body=await native('support/body-occluder.png'),front=await native('support/foreground-occluder.png');
  function compose(target,dx,dy,angle=0){
    const result=Buffer.from(underpaint);
    for(const id of ['01_tail_base','02_tail_tip','03_ear_left','04_ear_right']){
      const config=parts.find(part=>part.id===id);over(result,target===id?move(layers.get(id),dx,dy,angle,config.pivot):layers.get(id));
    }
    over(result,body);
    for(const id of ['05_ahoge','06_bow']){const config=parts.find(part=>part.id===id);over(result,target===id?move(layers.get(id),dx,dy,angle,config.pivot):layers.get(id));}
    over(result,front);return result;
  }
  const rest=compose(),restDiff=countDifferences(rest,base);
  assert.equal(restDiff.rgba,0,`静止重组有 ${restDiff.rgba} 个像素不同`);
  assert.equal(Buffer.compare(rest,await native('support/reconstructed.png')),0,'归档重组图不一致');
  const master=await readRaw('support/reconstructed.png');
  const referenceMaster=await sharp(manifest.reference.path).ensureAlpha().raw().toBuffer();
  const masterDiff=countDifferences(master,referenceMaster);
  assert.equal(masterDiff.rgba,0,'2048×3072 重组图与权威 P0 不一致');
  const baseVisible=await native('support/masks/01_tail_base_visible.png'),tipVisible=await native('support/masks/02_tail_tip_visible.png');
  const overlapRows=new Set();
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const offset=(y*W+x)*4;
    if((baseVisible[offset+3]||tipVisible[offset+3])&&layers.get('01_tail_base')[offset+3]===255&&layers.get('02_tail_tip')[offset+3]===255){
      overlapRows.add(y);assert.equal(Buffer.compare(layers.get('01_tail_base').subarray(offset,offset+4),layers.get('02_tail_tip').subarray(offset,offset+4)),0,'尾巴重叠带颜色不一致');
    }
  }
  assert.deepEqual([...overlapRows],[1077,1078,1079,1080,1081,1082],'尾巴实际重叠带不是 12px');
  const rootChecks=[];
  for(const part of parts)for(const sign of [-1,1]){
    const moved=compose(part.id,sign*5,sign*5),[cx,cy]=part.pivot;
    let samples=0,holes=0;
    for(let y=cy-4;y<=cy+4;y++)for(let x=cx-4;x<=cx+4;x++){
      const offset=(y*W+x)*4;
      if(base[offset+3]===255){samples++;if(moved[offset+3]<250)holes++;}
    }
    assert.ok(samples>0);assert.equal(holes,0,`${part.id} 偏移 ${sign*10}px 时支点露洞`);
    rootChecks.push({id:part.id,dx:sign*10,dy:sign*10,sampledOpaquePixels:samples,holes});
  }
  const leftEar=await image(layers.get('03_ear_left')).extract({left:120,top:140,width:321,height:346}).resize(256,256,{fit:'fill'}).raw().toBuffer();
  const rightEar=await image(layers.get('04_ear_right')).extract({left:520,top:140,width:311,height:336}).flop().resize(256,256,{fit:'fill'}).raw().toBuffer();
  assert.notEqual(Buffer.compare(leftEar,rightEar),0,'左右耳为完全镜像');
  const report={status:'passed',canvas:manifest.canvas,anchor:manifest.anchor,checkedFiles:files.length,partBytes:totalBytes,
    referenceSha256:P0_SHA256,supportChecks,
    restDifferenceNative:restDiff,restDifferenceMaster:masterDiff,
    canaries:['indexed-color','nul-text-block','missing-part','unlisted-part','opaque-corner','changed-visible-pixel','pending-reference-sha','changed-reference-bytes','missing-support-registration','missing-support-file','changed-support-bytes','changed-support-dimensions'],
    tailOverlapRowsMaster:[2154,2166],
    checks:['P0 固定摘要锁定','9 个渲染文件登记、尺寸、摘要和缺失校验','6 件 RGBA8、sRGB、同画布','逐行边缘透明扫描','可见区原像素零差异','隐藏补绘存在','独立支点与合理位置','双向 10px 支点无透明洞','左右耳非镜像','12px 尾巴中段重叠'],
    parts:details,rootChecks,
    visualEvidence:['preview.png','qa/parts-light-dark.png','qa/offset-positive-10px.png','qa/offset-negative-10px.png','qa/rotation-check.png']};
  writeJson('qa/validation-report.json',report);console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
