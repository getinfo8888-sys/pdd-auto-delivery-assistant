'use strict';

// Rebuild every app icon from the editable SVG with: npm run make-icon.
const fs = require('node:fs');
const path = require('node:path');
if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const result=spawnSync(require('electron'),[__filename],{stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  process.exit(result.status ?? 1);
} else {
  const {app,BrowserWindow}=require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const directory=path.resolve(__dirname,'..','src','renderer');
    const svg=fs.readFileSync(path.join(directory,'icon.svg'),'utf8');
    const window=new BrowserWindow({width:1024,height:1024,show:false,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    try {
      await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:"><body>'));
      const sizes=[16,20,24,32,48,64,128,256,512];
      const images=await window.webContents.executeJavaScript(`(async()=>{
        const image=new Image();image.src='data:image/svg+xml;base64,'+${JSON.stringify(Buffer.from(svg).toString('base64'))};await image.decode();
        return ${JSON.stringify(sizes)}.map(size=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=size;const context=canvas.getContext('2d');context.drawImage(image,0,0,size,size);return {size,png:canvas.toDataURL('image/png').split(',')[1]};});
      })()`);
      const frames=images.filter(row=>row.size<=256).map(row=>({size:row.size,data:Buffer.from(row.png,'base64')}));
      const header=Buffer.alloc(6+frames.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
      let offset=header.length;
      frames.forEach((frame,index)=>{const entry=6+index*16;header[entry]=header[entry+1]=frame.size===256?0:frame.size;header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(frame.data.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=frame.data.length;});
      fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([header,...frames.map(frame=>frame.data)]));
      fs.writeFileSync(path.join(directory,'icon.png'),Buffer.from(images.find(row=>row.size===512).png,'base64'));
      fs.writeFileSync(path.join(directory,'tray.png'),frames.find(row=>row.size===32).data);
      console.log(JSON.stringify({ok:true,master:'src/renderer/icon.svg',pngSize:512,icoSizes:frames.map(row=>row.size),traySize:32}));
    } finally {window.destroy();app.quit();}
  }).catch(error=>{console.error(error);app.exit(1);});
}
