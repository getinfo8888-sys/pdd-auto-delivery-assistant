'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {DesktopAlert,popupBounds}=require('../src/desktop-alert.cjs');
test('popup anchors inside the selected display work area, including negative coordinates',()=>{
  const area={x:-1920,y:80,width:1920,height:1000},bounds=popupBounds(area);
  assert.equal(bounds.x+bounds.width,-12);assert.equal(bounds.y+bounds.height,1068);assert.ok(bounds.x>=area.x);assert.ok(bounds.y>=area.y);
  const small=popupBounds({x:0,y:0,width:360,height:300});assert.ok(small.width<=336);assert.ok(small.height<=276);
});
test('desktop popup is isolated, shows without focus, validates sender and does not reopen after dismissal',async()=>{
  const windows=[];let opened=0;
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},setWindowOpenHandler:handler=>{this.openHandler=handler;},send:(name,value)=>{this.payload=value;},getURL:()=>popup.url});windows.push(this);}
    loadFile(){return Promise.resolve();}isDestroyed(){return !!this.destroyed;}showInactive(){this.shown=true;}destroy(){this.destroyed=true;this.emit('closed');}setBounds(bounds){this.bounds=bounds;}
  }
  const screen=new EventEmitter();screen.getPrimaryDisplay=()=>({workArea:{x:0,y:0,width:1920,height:1040}});
  const popup=new DesktopAlert({BrowserWindow:Window,screen,openWorkbench:()=>opened++});
  const notice={id:'fixture-incident',reason:'连接异常',startedAt:1,failures:3};popup.show(notice);await Promise.resolve();
  const win=windows[0];assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.nodeIntegration,false);assert.equal(win.options.skipTaskbar,true);assert.equal(win.options.alwaysOnTop,true);assert.equal(win.shown,true);assert.deepEqual(win.openHandler(),{action:'deny'});
  assert.equal(popup.action({sender:{},senderFrame:{}},'open'),false);
  const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};assert.equal(popup.action(event,'open'),true);assert.equal(opened,1);assert.equal(win.destroyed,true);
  popup.show(notice);assert.equal(windows.length,1);
  popup.show(null);popup.show({...notice,id:'next'});await Promise.resolve();assert.equal(windows.length,2);
  popup.dispose();assert.equal(screen.listenerCount('display-metrics-changed'),0);
});
