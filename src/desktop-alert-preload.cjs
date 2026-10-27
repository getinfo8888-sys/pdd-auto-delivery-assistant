const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopAlert',Object.freeze({
  onNotice:callback=>ipcRenderer.on('desktop-alert:notice',(_event,value)=>callback(value)),
  open:()=>ipcRenderer.send('desktop-alert:action','open'),
  dismiss:()=>ipcRenderer.send('desktop-alert:action','dismiss')
}));
