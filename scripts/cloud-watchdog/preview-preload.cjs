const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cloudPreview',Object.freeze({
  call:(name,value)=>['snapshot','save','mode','disable'].includes(name)?ipcRenderer.invoke('cloud-preview:'+name,value):Promise.reject(Error('未知操作')),
  onChanged:callback=>ipcRenderer.on('preview:changed',()=>callback())
}));
