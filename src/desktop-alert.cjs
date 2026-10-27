'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
function popupBounds(area){
  const width=Math.min(408,area.width-24),height=Math.min(322,area.height-24);
  return {x:area.x+area.width-width-12,y:area.y+area.height-height-12,width,height};
}
class DesktopAlert {
  constructor({BrowserWindow,screen,openWorkbench,mainWindow=()=>null,offscreen=false,onError=()=>{}}){
    Object.assign(this,{BrowserWindow,screen,openWorkbench,mainWindow,offscreen,onError});this.window=null;this.notice=null;this.disposed=false;
    this.file=path.join(__dirname,'renderer','desktop-alert.html');this.url=pathToFileURL(this.file).href;
    this.reposition=()=>{if(this.window&&!this.window.isDestroyed())this.window.setBounds(this.bounds());};
    screen.on('display-metrics-changed',this.reposition);screen.on('display-removed',this.reposition);
  }
  bounds(){const main=this.mainWindow();return popupBounds((main&&!main.isDestroyed()?this.screen.getDisplayMatching(main.getBounds()):this.screen.getPrimaryDisplay()).workArea);}
  show(notice){
    if(this.disposed)return;
    if(!notice){this.close();return;}
    if(this.notice?.id===notice.id)return;
    this.close();this.notice={...notice};
    const win=new this.BrowserWindow({...this.bounds(),show:false,frame:false,resizable:false,minimizable:false,maximizable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#ffffff',title:'助手异常提醒',icon:path.join(__dirname,'renderer','icon.ico'),autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'desktop-alert-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:this.offscreen,backgroundThrottling:false}});
    this.window=win;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event)=>event.preventDefault());
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.on('render-process-gone',()=>this.onError());
    win.on('closed',()=>{if(this.window===win)this.window=null;});
    win.loadFile(this.file).then(()=>{if(this.window!==win||win.isDestroyed())return;win.webContents.send('desktop-alert:notice',this.notice);if(!this.offscreen)win.showInactive();}).catch(()=>{if(this.window===win){this.close();this.onError();}});
  }
  trusted(event){return !this.disposed&&this.window&&!this.window.isDestroyed()&&event.sender===this.window.webContents&&event.senderFrame===this.window.webContents.mainFrame&&event.sender.getURL()===this.url;}
  action(event,action){
    if(!this.trusted(event))return false;
    if(action==='open'){this.openWorkbench();this.dismiss();return true;}
    if(action==='dismiss'){this.dismiss();return true;}
    return false;
  }
  // Dismiss the popup, retaining the incident ID to avoid nagging on each poll.
  dismiss(){if(this.window&&!this.window.isDestroyed())this.window.destroy();this.window=null;}
  close(){this.dismiss();this.notice=null;}
  dispose(){this.close();this.disposed=true;this.screen.removeListener('display-metrics-changed',this.reposition);this.screen.removeListener('display-removed',this.reposition);}
}
module.exports={DesktopAlert,popupBounds};
