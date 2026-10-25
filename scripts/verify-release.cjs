'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json'),dist=path.join(root,'dist');
const archive=path.join(dist,'win-unpacked/resources/app.asar');
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else files.push(path.relative(root,file));}}
walk(path.join(root,'src'));
for(const file of files)assert.ok(asar.extractFile(archive,file).equals(fs.readFileSync(path.join(root,file))),file);
for(const entry of asar.listPackage(archive).map(value=>value.replaceAll('\\','/')))assert.ok(entry==='/package.json'||entry==='/src'||entry.startsWith('/src/'),'Unexpected packaged content');
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,pkg.version);
const built=[`拼多多自动发货助手-${pkg.version}-安装包-x64.exe`,`拼多多自动发货助手-${pkg.version}-win-x64.exe`];
const names=[`PDD-Auto-Delivery-Assistant-Setup-${pkg.version}-x64.exe`,`PDD-Auto-Delivery-Assistant-Portable-${pkg.version}-x64.exe`];
// Release hosting may rewrite non-ASCII asset names. Keep the local Chinese
// installer name, while publishing stable ASCII download names and checksums.
const sums=names.map((name,index)=>{const bytes=fs.readFileSync(path.join(dist,built[index]));assert.ok(bytes.length>1024*1024,'Incomplete executable');fs.writeFileSync(path.join(dist,name),bytes);return createHash('sha256').update(bytes).digest('hex')+'  '+name;});
fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),sums.join('\n')+'\n');
const changelog=fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8');
const section=changelog.split(/^## /m).slice(1).find(value=>value.split(/\r?\n/,1)[0].trim()===pkg.version);
if(!section)throw Error('CHANGELOG 缺少当前版本的更新说明');
fs.mkdirSync(path.join(root,'work'),{recursive:true});
const notes=`${section.trim()}\n\n普通使用者请下载文件名带 Setup 的安装包，双击安装即可，无需安装 Node.js。Portable 为免安装便携版。源码 ZIP 供开发者使用。\n\n已有用户可覆盖安装，规则与登录会话保存在本机数据目录。首次使用请先阅读仓库中的使用说明，配置规则后再开启需要的自动功能。\n`;
fs.writeFileSync(path.join(root,'work/release-notes.md'),notes);
fs.writeFileSync(path.join(root,'work/release-assets.json'),JSON.stringify([...names,'SHA256SUMS.txt']));
console.log(JSON.stringify({ok:true,version:pkg.version,sourceFiles:files.length,assets:names,applicationSourceOnly:true}));
