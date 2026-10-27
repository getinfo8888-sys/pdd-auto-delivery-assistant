'use strict';
// A local window-only test: no merchant page, credentials or external requests.
const {app,BrowserWindow,screen,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DesktopAlert}=require('../src/desktop-alert.cjs');
const out=path.resolve(__dirname,'..','work');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'desktop-alert-smoke-profile'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  let opened=0;const errors=[];
  const popup=new DesktopAlert({BrowserWindow,screen,openWorkbench:()=>opened++,onError:()=>errors.push('popup_failed')});
  ipcMain.on('desktop-alert:action',(event,action)=>popup.action(event,action));
  popup.show({id:'isolated-desktop-preview',reason:'隔离测试：助手连接异常，正在尝试自动恢复。',startedAt:Date.now(),failures:3});
  const win=popup.window;let ready=false;
  for(let i=0;i<50;i++){if(win.isVisible()&&!win.webContents.isLoading()){ready=true;break;}await wait(100);}
  assert.equal(ready,true);assert.equal(win.isFocused(),false,'showInactive must not take typing focus');
  assert.equal(win.isAlwaysOnTop(),true);assert.equal(win.isVisible(),true);assert.equal(errors.length,0);
  await wait(250);fs.writeFileSync(path.join(out,'desktop-alert-native.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.getElementById('open').click()");
  for(let i=0;i<30&&!win.isDestroyed();i++)await wait(100);
  assert.equal(opened,1);assert.equal(win.isDestroyed(),true);
  popup.dispose();
  const result={ok:true,visibleWithoutFocus:true,openActionVerified:true,actualPlatformWrites:0,externalRequests:0};
  fs.writeFileSync(path.join(out,'desktop-alert-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
