const { contextBridge, ipcRenderer } = require('electron');
const reportNetwork = () => ipcRenderer.send('network:changed', navigator.onLine);
window.addEventListener('online', reportNetwork);
window.addEventListener('offline', reportNetwork);
window.addEventListener('DOMContentLoaded', reportNetwork, { once: true });
const channels = new Set(['snapshot','media:add','media:preview','config:update','settings:update','running:set','simulate:order','simulate:message','simulate:refund','platform:check','profile:save','profile:probe','profile:pick','official:inspect','browser:show','browser:bounds','browser:reload','browser:home','jobs:resolve','data:export','data:import','content:export','content:preview','content:repreview','content:cancel','content:apply','settings:startup','app:data-folder','app:background']);
contextBridge.exposeInMainWorld('workbench', Object.freeze({
  call: (name, value) => { if (!channels.has(name)) return Promise.reject(new Error('未知操作')); return ipcRenderer.invoke(name, value); },
  onChanged: callback => { const handler = () => callback(); ipcRenderer.on('state:changed', handler); return () => ipcRenderer.removeListener('state:changed', handler); }
}));
