'use strict';

// Calls the logged-in official page's own request/message functions. No cookies,
// tokens, vendor scripts, signatures, or third-party service are copied here.
// The module contracts below were observed in the official 2026-10-14 bundles;
// missing/changed contracts stop that operation instead of guessing an endpoint.
async function bridgeRuntime(action, payload) {
  let writeStarted=false;
  const id = value => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
    if (!['string','number'].includes(typeof value)) return '';
    const text = String(value).trim();
    return text && text.length < 200 && !/^(NaN|Infinity|undefined|null)$/i.test(text) ? text : '';
  };
  const clean = (value, max = 20000) => typeof value === 'string' ? value.slice(0,max) : '';
  const imageUrl = value => {
    try { const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && !url.port && ['pddpic.com','yangkeduo.com','pinduoduo.com','pddugc.com'].some(domain=>url.hostname===domain || url.hostname.endsWith('.'+domain)); } catch {return false;}
  };
  const numeric = value => value !== null && value !== '' && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const failure = reason => ({ status:'rejected', reason });
  if (location.origin !== 'https://mms.pinduoduo.com' || !(/^\/chat-merchant\//.test(location.pathname) || location.pathname === '/orders/list')) return failure('请打开官方客服或订单页面并登录');
  function components() {
    const roots = [];
    const app = document.querySelector('#app');
    if (app?.__vue__) roots.push(app.__vue__);
    if (!roots.length) for (const element of Array.from(document.querySelectorAll('body > *')).slice(0,40)) if (element.__vue__) roots.push(element.__vue__);
    const list=[], queue=[...roots], seen=new Set();
    while (queue.length && list.length<1200) {
      const component=queue.shift(); if (!component || seen.has(component)) continue;
      seen.add(component); list.push(component);
      if (Array.isArray(component.$children)) queue.push(...component.$children.slice(0,150));
    }
    return list;
  }
  const list=components();
  const store=list.map(component=>component.$store).find(value=>Array.isArray(value?.state?.chatList));
  const shopId=id(store?.state?.userInfo?.mall_id);
  const axios=list.map(component=>component.$axios).find(value=>typeof value?.post==='function');
  function receiptSenderReady(sdk) {
    if(typeof sdk?.sendCmdMsg!=='function')return false;
    const descriptor=Object.getOwnPropertyDescriptor(sdk,'sendCmdMsg');
    return descriptor ? descriptor.writable===true || typeof descriptor.set==='function' : Object.isExtensible(sdk);
  }
  function moduleExport(globalName, moduleId) {
    const chunks=globalThis[globalName];
    if (!Array.isArray(chunks) || typeof chunks.push!=='function') throw Error('官方页面模块尚未加载');
    let result;
    const probe='local_workbench_bridge_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    chunks.push([[], { [probe]: (_module,_exports,require) => {
      // Only retrieve the already loaded official module selected above.
      if (!require.c?.[moduleId]) throw Error('官方模块编号或版本已变化');
      result=require.c[moduleId].exports;
    } }, [[probe]]]);
    if (!result) throw Error('未取得官方模块');
    return result;
  }
  function ordersApi() {
    // gb/g in the official order bundle exports __mms.fetch. Use that existing
    // request client directly; the order loader has no entry callback support.
    const request=globalThis.__mms?.fetch;
    if (typeof request?.post!=='function' || typeof request?.get!=='function' || !document.querySelector('#__mms_order_list_wrapper')) throw Error('官方订单请求组件尚未加载');
    return {
      orders: { e:body=>request.post('/mangkhut/mms/recentOrderList',body), m:orderSn=>request.get('/chats/getUserByOrderSn?order_sn='+encodeURIComponent(orderSn)) },
      detail: { virtualShipping:body=>{
        const orderSn=body.orderShipRequestList[0].orderSn;
        const options=/^[0-9-]+$/.test(orderSn)?{headers:{'x-hebo-shard':'order_sn='+orderSn}}:undefined;
        return request.post('/robot/shop/orders/shipping/single',{...body,operateFrom:'MMS_VIRTUAL'},options);
      } },
    };
  }
  function chatApi() {
    const api=moduleExport('webpackJsonp',325).default;
    if (typeof api?.sendMsg!=='function') throw Error('官方消息接口契约已变化');
    return api;
  }
  function assertShop() {
    if (!shopId || !payload.expectedShopId || shopId!==payload.expectedShopId) throw Error('当前店铺与任务店铺不一致');
    if (/账户在别处登录|账号在其他设备登录/.test(document.body?.innerText || '')) throw Error('客服账号已在其他位置登录');
  }
  function assertWrite() {
    if (payload.allowWrite!==true || globalThis.__localDeliveryRunNonce!==payload.runNonce) throw Error('自动处理已暂停');
  }
  function pendingMessage(row, requirePendingTime = true) {
    if (!row || typeof row !== 'object') throw Error('官方会话记录结构已变化');
    const pendingTime = Number(row.last_unreply_time);
    if (requirePendingTime && !(pendingTime > 0) || Object.hasOwn(row, 'last_unreply_time') && !(pendingTime > 0)) return null;
    if (row.from?.role !== 'user' || Number(row.from?.user_type) === 6 || row.chat_type === 'conciliation' || Number(row.chat_type_id) === 9 || Number(row.type) !== 0 || Number(row.sub_type || 0) !== 0 || row.is_system_hint_mall || row.no_unreply_hint) return null;
    const buyerId = id(row.from?.uid), messageId = id(row.msg_id);
    const merchantUid = id(store?.state?.userInfo?.uid);
    if (!buyerId || !messageId || !Number.isFinite(Number(row.ts)) || typeof row.content !== 'string') throw Error('官方待回复消息缺少可核验的编号、时间或正文');
    if (row.to?.uid && merchantUid && id(row.to.uid) !== merchantUid) return null;
    const sentAt = Number(row.ts) * 1000;
    if (sentAt < Date.now() - 7 * 86400000 || sentAt > Date.now() + 60000) return null;
    return { shopId, buyerId, messageId, text: clean(row.content), sentAt, direction: 'incoming', pending: true, type: '0', subType: '0' };
  }
  const marked = value => value === true || value === 1 || value === '1';
  const officialAutomatic = row => row?.from?.role === 'mall_cs' && (marked(row.show_auto) || row.from.csid === '自动回复');
  async function pendingConversation(row, requirePendingTime = true) {
    const incoming = pendingMessage(row, requirePendingTime);
    if (incoming) return incoming;
    // A robot bubble or platform notice can hide the unanswered inquiry in
    // both pending lists and the latest-per-buyer response. The wait notice
    // (51) is incoming with no_unreply_hint=1 but retains last_unreply_time.
    // Resolve its source through read-only history without clearing that time.
    const pendingSince = Number(row.last_unreply_time) * 1000;
    const notice = [31,41,51,56].includes(numeric(row.type));
    if ((!notice && (!officialAutomatic(row) || !marked(row.need_reply))) || !(pendingSince > 0)) return null;
    const merchantUid = id(store?.state?.userInfo?.uid), api = chatApi();
    const incomingNotice = notice && row.from?.role === 'user' && row.to?.role === 'mall_cs' && id(row.to.uid) === merchantUid;
    const outgoingMarker = row.from?.role === 'mall_cs' && id(row.from.uid) === merchantUid && row.to?.role === 'user';
    const buyerId = incomingNotice ? id(row.from.uid) : outgoingMarker ? id(row.to.uid) : '';
    const markerMessageId = id(row.msg_id);
    if (!buyerId || !markerMessageId) throw Error('官方待回复提示的会话身份不完整');
    if (typeof api.list !== 'function' || typeof api.send !== 'function') throw Error('官方待回复历史核验接口尚未就绪');
    const data = await new Promise((resolve, reject) => {
      let captured = false;
      const original = api.send;
      const timer = setTimeout(() => reject(Error('核验官方提示后的待答复消息超时')), 12000);
      const failed = error => { clearTimeout(timer); reject(error); };
      const capture = function(packet, callback, ...rest) {
        if (!captured && packet?.cmd === 'list' && packet.list?.with?.role === 'user' && id(packet.list.with.id) === buyerId && packet.list.size === 30 && packet.notUpdateUnreplyTs === true) {
          captured = true;
          const request = original.call(this, packet, response => { clearTimeout(timer); resolve(response); }, ...rest);
          if (typeof request?.catch === 'function') request.catch(failed);
          return request;
        }
        return original.call(this, packet, callback, ...rest);
      };
      api.send = capture;
      try { api.list({user_sn:buyerId,size:30,notUpdateUnreplyTs:true}); if (!captured) failed(Error('官方待回复历史请求契约已变化')); }
      catch (error) { failed(error); }
      finally { if (api.send === capture) api.send = original; }
    });
    assertShop();
    if (id(store?.state?.userInfo?.uid) !== merchantUid || data?.result !== 'ok' || !Array.isArray(data.messages) || data.messages.length > 30 || Object.hasOwn(data, 'uid') && id(data.uid) !== buyerId || Object.hasOwn(data, 'user_sn') && id(data.user_sn) !== buyerId) throw Error('官方待回复历史响应不完整');
    const effective = [], ids = new Set(); let foundMarker = false;
    const hint = value => {
      if (value === undefined || value === null || value === false || value === 0 || value === '0') return false;
      if (marked(value)) return true;
      throw Error('官方待回复历史提示标记无法识别');
    };
    for (const message of data.messages) {
      const messageId = id(message?.msg_id), ts = Number(message?.ts);
      if (!messageId || ids.has(messageId) || numeric(message?.type) === null || !Number.isFinite(ts) || ts <= 946684800 || ts >= 4102444800) throw Error('官方待回复历史缺少有效的编号、类型或时间');
      ids.add(messageId);
      const incoming = message.from?.role === 'user' && id(message.from.uid) === buyerId && message.to?.role === 'mall_cs' && id(message.to.uid) === merchantUid;
      const outgoing = message.from?.role === 'mall_cs' && id(message.from.uid) === merchantUid && message.to?.role === 'user' && id(message.to.uid) === buyerId;
      if (hint(message.no_unreply_hint) || hint(message.is_system_hint_mall) || [31,41,51,56].includes(numeric(message.type)) || message.from?.role === 'user' && Number(message.from.user_type) === 6) {
        if (notice && messageId === markerMessageId) {
          if (!incoming && !outgoing) throw Error('官方提示历史的会话身份不一致');
          foundMarker = true;
        }
        continue;
      }
      if (!incoming && !outgoing) throw Error('官方待回复历史的会话身份不一致');
      if (officialAutomatic(message)) {
        if (!notice && messageId === markerMessageId) foundMarker = true;
        continue;
      }
      effective.push({message,incoming});
    }
    if (!foundMarker || !effective.length) throw Error('尚未取得完整的官方提示及买家咨询，稍后重新核验');
    if (!effective[0].incoming) return null; // A subsequent real merchant reply wins.
    const source = effective[0].message;
    if (Number(source.ts) * 1000 < pendingSince) throw Error('官方待回复时间与买家咨询尚未同步');
    const message = pendingMessage({...source,last_unreply_time:pendingSince/1000});
    if (!message) return null;
    if (notice) message.platformHintPending = {hintMessageId:markerMessageId,sourceMessageId:message.messageId,pendingSince,historyVerified:true};
    else message.officialAutoReplyPending = {automaticMessageId:markerMessageId,sourceMessageId:message.messageId,pendingSince,historyVerified:true};
    return message;
  }
  const orderProjection = row => {
    const orderId=id(row?.order_sn);
    if (!orderId) return null;
    const os=numeric(row.order_status), ps=numeric(row.pay_status), gs=numeric(row.group_status), ss=numeric(row.shipping_status);
    // The live official list represents no aftersale as two explicit nulls.
    // Missing fields or a null status with an actual aftersale ID stay unknown.
    const noAfterSales=row.after_sales_status===null&&row.after_sales_id===null;
    const as=noAfterSales?0:numeric(row.after_sales_status);
    const paid=os===1 && ps===2 && gs===1;
    const refunded=ps===3 || ps===4 || as!==null && as!==0;
    return { orderId, itemId:id(row.goods_id), title:clean(row.goods_name), sku:clean(row.spec), buyerId:id(row.uid),
      paid, refunded, cancelled:os===2, shipped:ss===1 || ss===2, eligible:paid && ss===0 && as===0,
      status:paid && ss===0 ? '待发货' : paid && ss===1 ? '已发货' : '其他状态',
      paidAt:numeric(row.pay_time)>946684800 && numeric(row.pay_time)<4102444800 ? Number(row.pay_time)*1000 : null,
      itemCount:1 };
  };
  function orderQuery(page, orderId) {
    const now=Math.floor(Date.now()/1000);
    return { pageNumber:page, pageSize:50, orderType:orderId ? 0 : 1, afterSaleType:orderId ? -1 : 1,
      groupStartTime:now-90*86400, groupEndTime:now, remarkStatus:-1, sortType:7, urgeShippingStatus:-1,
      ...(orderId ? {orderSn:orderId} : {}) };
  }
  async function getOrder(orderId) {
    const {orders}=ordersApi();
    const result=await orders.e(orderQuery(1,orderId));
    if (!Array.isArray(result?.pageItems)) throw Error('官方订单响应结构已变化');
    const matches=result.pageItems.map(orderProjection).filter(row=>row?.orderId===orderId);
    if (matches.length!==1) throw Error('无法唯一核验订单当前状态');
    const row=matches[0];
    if (!row.buyerId) row.buyerId=id((await orders.m(orderId))?.uid);
    return row;
  }
  function refundProjection(row) {
    const refundId=id(row?.id), orderId=id(row?.orderSn);
    const type=numeric(row?.afterSalesType), status=numeric(row?.afterSalesStatus);
    if (!refundId || !orderId || type===null || status===null) return null;
    // Official mapAfterSaleStatus: 1/11 merchant action, 4 refund processing,
    // 5 refunded; 6/7/12/13 closed. Only refund/return-refund types are acted on.
    const pending=[1,2].includes(type) && [1,11].includes(status);
    return { refundId, orderId, buyerId:id(row.uid), title:clean(row.goodsName), refundVersion:row.version,
      status:pending ? 'pending' : status===4 ? 'approved' : status===5 ? 'refunded' : [6,7,12,13].includes(status) ? 'closed' : 'processing',
      platformStatus:status, afterSalesType:type };
  }
  async function refundDetail(job) {
    if (!axios) throw Error('官方客服请求组件尚未加载');
    const detail=await axios.post('/mercury/chat/afterSales/queryDetail',{orderSn:job.orderId,id:job.refundId});
    if (!detail || numeric(detail.version)===null) throw Error('未取得退款申请的最新版本');
    if (detail.orderSn && id(detail.orderSn)!==job.orderId || detail.id && id(detail.id)!==job.refundId) throw Error('退款申请与订单对应关系不一致');
    let result=refundProjection({...detail,id:job.refundId,orderSn:job.orderId});
    if (!result) {
      const page=await axios.post('/mercury/mms/afterSales/queryList',{pageNumber:1,pageSize:50,afterSalesStatusList:[],orderByExpireTimeAsc:true,searchText:job.orderId});
      const rows=Array.isArray(page?.list) ? page.list.filter(row=>id(row.id)===job.refundId && id(row.orderSn)===job.orderId) : [];
      if (rows.length===1 && numeric(rows[0].version)===numeric(detail.version)) result=refundProjection(rows[0]);
    }
    if (!result) throw Error('官方退款详情结构已变化');
    return result;
  }
  try {
    if (action==='health') {
      const orders=location.pathname==='/orders/list';
      if (orders) { ordersApi(); return {ready:true,kind:'orders',contract:'pdd-orders-20261014'}; }
      chatApi();
      const socketStatus=globalThis.__localWorkbenchPddSocket?.status(id(store?.state?.userInfo?.uid));
      return {ready:!!shopId && !!axios,shopId,kind:'chat',contract:'pdd-chat-20261014',canSend:true,canSendViaSocket:socketStatus?.ready===true,canUseOfficialReceiptPipeline:receiptSenderReady(store?.state?.IMSDK),socketState:socketStatus?.state||'tracker_missing',canReadRefunds:!!axios};
    }
    if (action === 'unreplied') {
      assertShop();
      if (!axios) throw Error('官方客服请求组件尚未加载');
      const page = Number.isInteger(payload.page) && payload.page > 0 ? payload.page : 1;
      const data = await axios.post('/plateau/chat/unreply_conversations', { page, size: 100 });
      if (!Array.isArray(data?.conversations) || ![true,false,0,1].includes(data.has_more)) throw Error('官方待回复列表结构已变化');
      const messages=[];for (const row of data.conversations) { const message=await pendingConversation(row);if(message)messages.push(message); }
      return { ready: true, page, messages, hasMore: !!data.has_more, scanned: data.conversations.length };
    }
    if (action === 'reply-check') {
      assertShop();
      const buyerId = id(payload.buyerId), api = chatApi();
      if (!buyerId || typeof api.getLatestUserConversation !== 'function') throw Error('官方会话核验接口尚未就绪');
      const data = await new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(Error('核验待回复会话超时')), 12000);
        try { api.getLatestUserConversation(buyerId, response => { clearTimeout(timer); resolve(response); }); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
      if (data?.result !== 'ok' || id(data.uid) !== buyerId || !Object.hasOwn(data, 'conversation')) throw Error('官方会话核验结果不完整');
      const message = data.conversation === null ? null : await pendingConversation(data.conversation, false);
      if (message && message.buyerId !== buyerId) throw Error('官方会话买家编号不一致');
      return { ready: true, pending: !!message, message };
    }
    if (action === 'reply-followup-check') {
      try {
        assertShop();
        const buyerId = id(payload.buyerId), sourceMessageId = id(payload.sourceMessageId);
        const ownReplyMessageIds = payload.ownReplyMessageIds;
        const merchantUid = id(store?.state?.userInfo?.uid), api = chatApi();
        if (!buyerId || !sourceMessageId || !merchantUid || !Array.isArray(ownReplyMessageIds) || !ownReplyMessageIds.length || ownReplyMessageIds.length > 20 || ownReplyMessageIds.some(value => !/^[1-9]\d*$/.test(id(value)))) throw Error('后续答复缺少可核验的买家、来源或平台回执编号');
        if (typeof api.list !== 'function' || typeof api.send !== 'function') throw Error('官方会话历史核验接口尚未就绪');
        const ownIds = new Set(ownReplyMessageIds.map(id));
        const data = await new Promise((resolve, reject) => {
          let captured = false;
          const originalSend = api.send;
          const timer = setTimeout(() => reject(Error('读取会话历史超时')), 12000);
          const failed = error => { clearTimeout(timer); reject(error); };
          const captureList = function(packet, callback, ...rest) {
            if (!captured && packet?.cmd === 'list' && packet.list?.with?.role === 'user' && id(packet.list.with.id) === buyerId && packet.list.size === 20 && packet.notUpdateUnreplyTs === true) {
              captured = true;
              const result = originalSend.call(this, packet, response => { clearTimeout(timer); resolve(response); }, ...rest);
              if (typeof result?.catch === 'function') result.catch(failed);
              return result;
            }
            return originalSend.call(this, packet, callback, ...rest);
          };
          api.send = captureList;
          try {
            api.list({ user_sn: buyerId, size: 20, notUpdateUnreplyTs: true });
            if (!captured) failed(Error('官方会话历史请求契约已变化'));
          } catch (error) { failed(error); }
          finally { if (api.send === captureList) api.send = originalSend; }
        });
        assertShop();
        if (id(store?.state?.userInfo?.mall_id) !== shopId || id(store?.state?.userInfo?.uid) !== merchantUid) throw Error('读取历史期间登录身份发生变化');
        if (data?.result !== 'ok' || !Array.isArray(data.messages) || data.messages.length > 20 || Object.hasOwn(data, 'uid') && id(data.uid) !== buyerId || Object.hasOwn(data, 'user_sn') && id(data.user_sn) !== buyerId) throw Error('官方会话历史响应结构已变化');
        const hintFlag = value => {
          if (value === undefined || value === null || value === false || value === 0 || value === '0') return false;
          if (value === true || value === 1 || value === '1') return true;
          throw Error('官方历史消息提示标记无法识别');
        };
        const effective = [], messageIds = new Set();
        // The official list response is newest first. Keep server ordering even
        // when two rows have identical second-resolution timestamps.
        for (const row of data.messages) {
          if (!row || typeof row !== 'object' || Array.isArray(row) || !id(row.msg_id) || !['number', 'string'].includes(typeof row.type) || numeric(row.type) === null || !['number', 'string'].includes(typeof row.ts) || !Number.isFinite(Number(row.ts)) || Number(row.ts) <= 946684800 || Number(row.ts) >= 4102444800) throw Error('官方历史消息缺少有效的编号、类型或时间');
          const messageId = id(row.msg_id);
          if (messageIds.has(messageId)) throw Error('官方历史消息编号重复，无法唯一核验');
          messageIds.add(messageId);
          if (hintFlag(row.no_unreply_hint) || hintFlag(row.is_system_hint_mall) || [31, 56].includes(numeric(row.type))) continue;
          if (row.from?.role === 'user' && Number(row.from?.user_type) === 6) continue;
          const incoming = row.from?.role === 'user' && id(row.from.uid) === buyerId && row.to?.role === 'mall_cs' && id(row.to.uid) === merchantUid;
          const outgoing = row.from?.role === 'mall_cs' && id(row.from.uid) === merchantUid && row.to?.role === 'user' && id(row.to.uid) === buyerId;
          if (!incoming && !outgoing) return { ready: true, allowFollowup: false, reason: '历史消息参与者与当前会话不一致' };
          if (!officialAutomatic(row)) effective.push({ messageId, incoming, outgoing });
        }
        const source = effective.find(row => row.messageId === sourceMessageId);
        const latestIncoming = effective.find(row => row.incoming), latest = effective[0];
        if (!source?.incoming) return { ready: true, allowFollowup: false, reason: '近期历史不足以核验本次买家咨询' };
        if (latestIncoming?.messageId !== sourceMessageId) return { ready: true, allowFollowup: false, reason: '买家已有更新的咨询，取消旧后续答复' };
        if (!latest?.outgoing || !ownIds.has(latest.messageId)) return { ready: true, allowFollowup: false, reason: '最近有效消息不是本次已确认的自动答复' };
        return { ready: true, allowFollowup: true };
      } catch (error) {
        return { ready: false, status: 'deferred', allowFollowup: false, reason: clean(error?.message, 500) || '暂时无法核验后续答复' };
      }
    }
    if(action==='image-upload') {
      assertShop();
      if (payload.allowAssetUpload!==true) throw Error('未允许上传图片');
      const image=payload.image;
      if (!image || !['image/png','image/jpeg'].includes(image.mime) || typeof image.name!=='string' || image.name.length>255 || typeof image.base64!=='string' || image.base64.length>7*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) throw Error('上传图片格式不正确');
      const raw=Uint8Array.from(atob(image.base64),char=>char.charCodeAt(0));
      if (!raw.length || raw.length>5*1024*1024) throw Error('图片需要小于 5 MB');
      // Module 211 is the official chat-media uploader. It obtains a scoped
      // /plateau/file/pre_upload permission and submits JSON with a data URL.
      // The generic baseUtil multipart/gallery uploader serves other MMS pages.
      const uploader=moduleExport('webpackJsonp',211).default;
      if (typeof uploader?.uploadImage!=='function') throw Error('官方客服图片上传组件尚未就绪');
      let result;
      try { result=await uploader.uploadImage({rawImage:'data:'+image.mime+';base64,'+image.base64}); }
      catch (error) {
        const status=numeric(error?.response?.status ?? error?.status),data=error?.response?.data;
        return {status:'rejected',stage:'chat-image-upload',httpStatus:status,platformCode:numeric(data?.error_code ?? data?.errorCode),reason:clean(data?.error_msg || data?.errorMsg || error?.message,500) || '客服图片上传失败'};
      }
      assertShop();
      if (result?.type==='get_upload_sign_failed' || result?.type==='upload_image_failed') {
        const data=result.res || result;
        return {status:'rejected',stage:result.type==='get_upload_sign_failed'?'chat-upload-permission':'chat-image-upload',httpStatus:numeric(result.status),platformCode:numeric(data.error_code ?? data.errorCode),reason:clean(data.error_msg || data.errorMsg || data.message,500) || '官方客服图片上传被拒绝'};
      }
      if (!imageUrl(result?.url)) throw Error('官方未返回有效的图片地址');
      return {status:'uploaded',url:result.url,uploadRoute:'official-chat-media-v1'};
    }
    if(action==='delivery-check' || action==='attachment-check'){
      assertShop();
      const job=payload.job,buyerId=id(job?.buyerId),merchantUid=id(store?.state?.userInfo?.uid),api=chatApi();
      const attachment=action==='attachment-check',expectedType=job?.partKind==='image'?1:0;
      if (attachment && (!job?.parentJobId || !['link','image'].includes(job.partKind))) throw Error('附加消息计划不完整');
      const expected=attachment?job.content:typeof job?.deliveryWireContent==='string'?job.deliveryWireContent:job?.content;
      if(!buyerId||!merchantUid||typeof expected!=='string'||!Number.isFinite(job?.attemptedAt)||job.attemptedAt<=0)throw Error('发货核实缺少买家、正文或发送时间');
      if(typeof api.list!=='function'||typeof api.send!=='function')throw Error('官方会话历史核验接口尚未就绪');
      const known=payload.claimedMessageIds||[];
      if(!Array.isArray(known)||known.length>500||known.some(value=>!id(value)))throw Error('已确认消息编号不完整');
      const data=await new Promise((resolve,reject)=>{
        let captured=false;const originalSend=api.send;
        const timer=setTimeout(()=>reject(Error('读取发货会话历史超时')),12000);
        const failed=error=>{clearTimeout(timer);reject(error);};
        const capture=function(packet,callback,...rest){
          if(!captured&&packet?.cmd==='list'&&packet.list?.with?.role==='user'&&id(packet.list.with.id)===buyerId&&packet.list.size===20&&packet.notUpdateUnreplyTs===true){
            captured=true;const pending=originalSend.call(this,packet,response=>{clearTimeout(timer);resolve(response);},...rest);
            if(typeof pending?.catch==='function')pending.catch(failed);return pending;
          }return originalSend.call(this,packet,callback,...rest);
        };
        api.send=capture;
        try{api.list({user_sn:buyerId,size:20,notUpdateUnreplyTs:true});if(!captured)failed(Error('官方发货会话请求契约已变化'));}
        catch(error){failed(error);}finally{if(api.send===capture)api.send=originalSend;}
      });
      assertShop();
      if(id(store?.state?.userInfo?.uid)!==merchantUid||data?.result!=='ok'||!Array.isArray(data.messages)||data.messages.length>20||Object.hasOwn(data,'uid')&&id(data.uid)!==buyerId||Object.hasOwn(data,'user_sn')&&id(data.user_sn)!==buyerId)throw Error('官方发货会话历史响应不完整');
      const claimed=new Set(known.map(id)),start=Math.floor(job.attemptedAt/1000),candidates=[],times=[];
      for(const row of data.messages){
        const ts=Number(row?.ts);
        if(!id(row?.msg_id)||!Number.isFinite(ts)||ts<946684800||ts>=4102444800||numeric(row?.type)===null)throw Error('官方发货历史缺少消息编号、类型或时间');
        const incoming=row.from?.role==='user'&&id(row.from.uid)===buyerId&&row.to?.role==='mall_cs'&&id(row.to.uid)===merchantUid;
        const outgoing=row.from?.role==='mall_cs'&&id(row.from.uid)===merchantUid&&row.to?.role==='user'&&id(row.to.uid)===buyerId;
        if(!incoming&&!outgoing)throw Error('发货历史的会话身份不一致');
        times.push(ts);
        if(row.from?.role==='mall_cs'&&id(row.from.uid)===merchantUid&&row.to?.role==='user'&&id(row.to.uid)===buyerId&&numeric(row.type)===expectedType&&row.content===expected&&(ts>=start || attachment&&payload.allowPrevious===true)&&!claimed.has(id(row.msg_id))){
          if(!/^[1-9]\d*$/.test(id(row.msg_id)))throw Error('发货消息缺少平台回执编号');candidates.push(id(row.msg_id));
        }
      }
      if(candidates.length===1 || attachment&&payload.allowPrevious===true&&candidates.length)return {ready:true,status:'confirmed',messageId:candidates[0]};
      // This lookup is only an optimization after an explicit rejection. A
      // missing historical copy is not an authoritative non-delivery result.
      // The caller may retry the explicitly rejected send without waiting for
      // the uncertain-write synchronization window to elapse again.
      if(attachment&&payload.allowPrevious===true)return {ready:true,status:'not_found'};
      if(candidates.length>1)return {ready:true,status:'unknown',reason:'有多条相同发货消息，继续核实，暂不重复发送'};
      const covered=data.messages.length<20||Math.min(...times)<=start;
      if(covered&&Date.now()-job.attemptedAt>=60000)return {ready:true,status:'not_sent'};
      return {ready:true,status:'unknown',reason:'等待官方消息记录同步，继续核实'};
    }
    if (action === 'unreplied-history') {
      assertShop();
      const api = chatApi();
      if (typeof api.getLatestConversation !== 'function') throw Error('官方历史会话接口尚未就绪');
      const page = Number.isInteger(payload.page) && payload.page > 0 ? payload.page : 1;
      const endTime = Number.isSafeInteger(payload.endTime) ? payload.endTime : Math.floor(Date.now()/1000);
      const data = await new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(Error('读取近七天会话超时')),12000);
        try { api.getLatestConversation({page,size:100,startTime:endTime-7*86400,endTime,cb:response=>{clearTimeout(timer);resolve(response);}}); }
        catch(error) {clearTimeout(timer);reject(error);}
      });
      if (data?.result !== 'ok' || !Array.isArray(data.conversations) || ![true,false,0,1].includes(data.has_more)) throw Error('官方近七天会话列表结构已变化');
      const messages=[];for(const row of data.conversations){const message=await pendingConversation(row);if(message)messages.push(message);}
      return { ready:true, page, messages, hasMore:!!data.has_more, scanned:data.conversations.length };
    }
    if (action==='waiting') {
      const {orders}=ordersApi(); const page=Number.isInteger(payload.page) && payload.page>0 ? payload.page : 1;
      const data=await orders.e(orderQuery(page));
      if (!Array.isArray(data?.pageItems) || numeric(data.totalItemNum)===null) throw Error('官方订单列表结构已变化');
      return {ready:true, orders:data.pageItems.map(orderProjection).filter(Boolean), page, total:Number(data.totalItemNum), hasMore:page*50<Number(data.totalItemNum)};
    }
    if (action==='order') return {ready:true,order:await getOrder(id(payload.orderId))};
    if (action==='refunds') {
      if (location.pathname!=='/orders/list') assertShop();
      const request=location.pathname==='/orders/list' ? globalThis.__mms?.fetch : axios;
      if (typeof request?.post!=='function') throw Error('官方请求组件尚未加载');
      const page=Number.isInteger(payload.page) && payload.page>0 ? payload.page : 1;
      const data=await request.post('/mercury/mms/afterSales/queryList',{pageNumber:page,pageSize:50,afterSalesStatusList:['1','2','3','14','21','32'],orderByExpireTimeAsc:true,searchText:''});
      if (!Array.isArray(data?.list) || numeric(data.total)===null) throw Error('官方售后列表结构已变化');
      const rows=data.list.map(refundProjection);
      if (rows.some(row=>!row)) throw Error('官方售后记录字段不完整');
      return {ready:true, refunds:rows, page, total:Number(data.total), hasMore:page*50<Number(data.total)};
    }
    if (action==='refund-status') { assertShop(); return {ready:true,refund:await refundDetail(payload.job)}; }
    if (action==='refund') {
      assertShop();
      const job=payload.job, latest=await refundDetail(job);
      if (['approved','refunded'].includes(latest.status)) return {status:'confirmed',alreadyCompleted:true};
      if (latest.status!=='pending') return failure('退款申请当前不需要商家同意退款');
      const buyerId=latest.buyerId || job.buyerId;
      if (!id(buyerId)) return failure('退款申请缺少可核验的买家编号');
      assertShop(); assertWrite();
      // This same endpoint/payload is used by the official chat refund dialog.
      writeStarted=true;
      const response=await axios.post('/mercury/chat/afterSales/agreeRefund',{uid:buyerId,orderSn:job.orderId,id:job.refundId,version:latest.refundVersion});
      if (response?.success===false || response?.errorCode || response?.error_code) return failure('拼多多未接受退款操作');
      // A resolved call is followed by a fresh state check. HTTP 200 alone is
      // never treated as a successful refund.
      const after=await refundDetail(job);
      return ['approved','refunded'].includes(after.status) ? {status:'confirmed'} : {status:'uncertain',reason:'平台尚未返回退款状态变更'};
    }
    if (action==='ship') {
      const job=payload.job, latest=await getOrder(job.orderId);
      if (latest.shipped && !latest.refunded && !latest.cancelled) return {status:'confirmed',alreadyCompleted:true};
      if (!latest.eligible || latest.buyerId!==job.buyerId) return failure('订单不再待发货，或买家身份发生变化');
      assertWrite();
      writeStarted=true;
      const response=await ordersApi().detail.virtualShipping({orderShipRequestList:[{orderSn:job.orderId,deliveryType:0,virtualGoodesContent:['5',job.content]}],isSingleShipment:1,overWrite:1,functionType:6,isVirtualGoods:true});
      const results=response?.orderShipResultList;
      if (!Array.isArray(results) || results.length!==1 || results[0].orderSn && id(results[0].orderSn)!==job.orderId) return {status:'uncertain',reason:'未取得对应订单的发货回执'};
      const code=numeric(results[0].shippingResultCode);
      return code!==null && code>=100 ? {status:'confirmed'} : code!==null ? failure(clean(results[0].shippingResultMsg,1000)||'平台拒绝发货') : {status:'uncertain',reason:'缺少发货结果码'};
    }
    if (action==='send') {
      assertShop(); assertWrite();
      const job=payload.job;
      const isImage=job.partKind==='image';
      if (isImage && (!job.parentJobId || job.image?.shopId!==shopId || job.image?.url!==job.content || !imageUrl(job.content) || !Number.isSafeInteger(job.image.width) || !Number.isSafeInteger(job.image.height) || job.image.width<1 || job.image.height<1 || !Number.isSafeInteger(job.image.bytes) || job.image.bytes<1)) return failure('图片消息资料不完整或不属于当前店铺');
      if(job.type==='reply' && (typeof job.wireContent!=='string' || !/^[0-9a-f]{64}$/.test(job.wireContentSha256 || '')))return failure('答复缺少已持久化的发送正文或校验值，尚未提交');
      const content=job.type==='reply' && typeof job.wireContent==='string'?job.wireContent:job.type==='delivery'&&typeof job.deliveryWireContent==='string'?job.deliveryWireContent:job.content;
      if (!id(job.buyerId) || !clean(content)) return failure('消息缺少目标买家或正文');
      const trackedMessage=['reply','delivery'].includes(job.type);
      const outbound=trackedMessage?{sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content))),byte=>byte.toString(16).padStart(2,'0')).join(''),length:content.length}:null;
      if(job.type==='reply' && outbound.sha256!==job.wireContentSha256)return failure('发送正文校验不一致，尚未提交');
      if(job.type==='delivery'&&job.deliveryWireContentSha256&&outbound.sha256!==job.deliveryWireContentSha256)return failure('发货发送正文校验不一致，尚未提交');
      if (job.parentJobId && content!==job.content) return failure('附加链接或图片地址被改动，尚未提交');
      const api=chatApi();
      const socket=trackedMessage?globalThis.__localWorkbenchPddSocket:null;
      if(trackedMessage&&(globalThis.browserType!=='web'||typeof socket?.sendPacket!=='function'||!socket.status(id(store?.state?.userInfo?.uid)).ready))return {status:'deferred',reason:'官方消息连接尚未认证完成，尚未提交'};
      const sdk=trackedMessage?store?.state?.IMSDK:null;
      if(trackedMessage&&!receiptSenderReady(sdk))return {status:'deferred',reason:'官方消息回执处理组件尚未就绪，尚未提交'};
      assertShop();assertWrite();
      writeStarted=true;
      return await new Promise(resolve=>{
        let ended=false;
        let originalSdkSend,routeSdk;
        const cleanup=()=>{if(sdk&&sdk.sendCmdMsg===routeSdk)sdk.sendCmdMsg=originalSdkSend;};
        const finish=result=>{ if (!ended) {ended=true;clearTimeout(timer);cleanup();resolve(outbound?{...result,outbound}:result);} };
        const timer=setTimeout(()=>finish({status:'uncertain',reason:'等待官方消息回执超时'}),12000);
        let captured=false,requestId='';const originalSend=api.send;
        // Keep the official send -> wsPromise -> consumerOnMessage -> store
        // updates -> callback chain intact. Only its SDK transport is routed.
        if(sdk){
          originalSdkSend=sdk.sendCmdMsg;
          routeSdk=function(packet,...args){
            if(packet?.cmd!=='send_message'||id(packet.request_id)!==requestId||packet.message?.content!==content||id(packet.message?.to?.uid)!==job.buyerId)return originalSdkSend.call(this,packet,...args);
            cleanup();
            try{assertShop();assertWrite();}catch(error){return Promise.reject(error);}
            outbound.transport='official_m_ws';
            return socket.sendPacket(packet,{merchantUid:id(store?.state?.userInfo?.uid),runNonce:payload.runNonce});
          };
          sdk.sendCmdMsg=routeSdk;
        }
        const routeToSocket=function(packet,callback,...rest){
          if(packet?.cmd!=='send_message'||packet.message?.content!==content||id(packet.message?.to?.uid)!==job.buyerId)return originalSend.call(this,packet,callback,...rest);
          if (isImage && (packet.message.type!==1 || packet.message.size?.width!==job.image.width || packet.message.size?.height!==job.image.height)) {finish(failure('官方图片消息构造契约已变化，尚未提交'));return;}
          captured=true;requestId=id(packet.request_id);
          if(!requestId){finish(failure('官方消息缺少请求编号，尚未提交'));return;}
          return originalSend.call(this,packet,callback,...rest);
        };
        if(socket)api.send=routeToSocket;
        const media=isImage ? {config:{size:{width:job.image.width,height:job.image.height,image_size:Math.ceil(job.image.bytes/1024)}},info:{thumb_data:typeof payload.imagePreview==='string' && payload.imagePreview.startsWith('data:image/')?payload.imagePreview:content}} : {};
        try { api.sendMsg({uid:job.buyerId,content,type:isImage?1:0,...media,cb:response=>{
          if (response?.result==='my_push') return;
          if (response?.result==='ok' && id(response.msg_id) && /^\d+$/.test(id(response.msg_id))) finish({status:'confirmed',messageId:id(response.msg_id)});
          else if (response?.result==='fail') finish(failure(clean(response.error,1000)||'平台拒绝发送消息'));
        }});if(socket&&!captured)finish({status:'deferred',reason:'官方页面正在处理上一条消息，尚未提交'}); } catch { finish({status:'uncertain',reason:'官方发送组件调用异常'}); }
        finally{if(socket&&api.send===routeToSocket)api.send=originalSend;}
      });
    }
    return failure('未知平台操作');
  } catch (error) {
    // Business request rejections and connection failures can have different
    // outcomes. A write exception stays uncertain for subsequent state checks.
    return {status:writeStarted && !error?.errorCode && !error?.error_code ? 'uncertain' : 'rejected',ready:false,reason:clean(error?.message,500)||'官方页面接口暂不可用'};
  }
}

const ACTIONS=new Set(['health','unreplied','unreplied-history','reply-check','reply-followup-check','delivery-check','attachment-check','image-upload','waiting','order','refunds','refund-status','send','ship','refund']);
function makeBridgeScript(action,payload={}) {
  if (!ACTIONS.has(action)) throw new TypeError('未知平台操作');
  return `(${bridgeRuntime.toString()})(${JSON.stringify(action)},${JSON.stringify(payload)})`;
}
module.exports={makeBridgeScript};
