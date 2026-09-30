(() => {
  'use strict';
  const BUILD = '20260930-github-bridge-v1';
  const actions = ['products','getBrandSettings','adminLogin','adminSessionProfile','adminProducts','orders','adminLogout'];
  const fail = code => Object.assign(new Error(code),{code});
  function validFields(action, fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
    const keys = Object.keys(fields).sort().join(',');
    if (action === 'products') return keys === '' || (keys === 'includeBrandSettings' && fields.includeBrandSettings === '1');
    if (action === 'getBrandSettings') return keys === '';
    if (action === 'adminLogin') return ['password,username','includeProducts,password,username'].includes(keys) &&
      (!Object.prototype.hasOwnProperty.call(fields,'includeProducts') || fields.includeProducts === '1') &&
      typeof fields.username === 'string' && fields.username.length > 0 && fields.username.length <= 128 &&
      typeof fields.password === 'string' && fields.password.length > 0 && fields.password.length <= 128;
    if (!['adminSessionProfile','adminProducts','orders','adminLogout'].includes(action)) return false;
    return (keys === 'token' || (action === 'adminSessionProfile' && keys === 'includeProducts,token' && fields.includeProducts === '1')) &&
      typeof fields.token === 'string' && fields.token.length <= 512;
  }
  class Client {
    constructor(iframe, endpoint, timeoutMs) {
      const url = new URL(endpoint);
      if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search || url.hash) throw fail('INVALID_BRIDGE_ENDPOINT');
      const origins = {'http://127.0.0.1:8792':'local','https://sunilthornwork-web.github.io':'github'};
      if (!Object.prototype.hasOwnProperty.call(origins,location.origin)) throw fail('INVALID_BRIDGE_ORIGIN');
      this.channel = Client.randomHex(32);
      this.iframe = iframe; this.pending = null; this.peer = null; this.closed = false;
      this.onMessage = event=>this.receive(event);
      this.ready = new Promise((resolve,reject)=>{
        this.resolveReady=resolve;this.rejectReady=reject;
        this.readyTimer=setTimeout(()=>{reject(fail('REQUEST_TIMEOUT'));this.close();},timeoutMs);
      });
      window.addEventListener('message',this.onMessage);
      url.searchParams.set('view','github-bridge');url.searchParams.set('bridgeOrigin',origins[location.origin]);url.searchParams.set('channel',this.channel);
      iframe.referrerPolicy='no-referrer';iframe.src=url.href;
    }
    static randomHex(bytes) {return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
    receive(event) {
      if (this.closed || !/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(event.origin)) return;
      const data=event.data;
      if (!data || data.channel!==this.channel || !event.source) return;
      if (data.type==='lp-bridge-ready' && !this.peer && data.build===BUILD) {
        this.peer=event.source;this.peerOrigin=event.origin;clearTimeout(this.readyTimer);this.resolveReady();return;
      }
      if (event.source!==this.peer || event.origin!==this.peerOrigin || data.type!=='lp-bridge-result' || !this.pending || data.requestId!==this.pending.id) return;
      const pending=this.pending,value=data.value;
      if (!value || value.ok!==true) {
        const code=value&&['BRIDGE_ACTION_BLOCKED','BRIDGE_BACKEND_FAILURE','BRIDGE_RPC_FAILED','BRIDGE_BUSY'].includes(value.code)?value.code:'BRIDGE_CALL_FAILED';
        const error=fail(code);
        if(code==='BRIDGE_RPC_FAILED')error.code='NETWORK_ERROR';
        this.finish(error);return;
      }
      try {
        if (value.build!==BUILD || value.channel!==this.channel || value.action!==pending.action || value.requestId!==pending.id || typeof value.raw!=='string' || value.raw.length>4*1024*1024) throw Error();
        const body=JSON.parse(value.raw);
        const handler=['products','getBrandSettings'].includes(pending.action)?'doGet':'doPost';
        if (!body || typeof body.success!=='boolean' || body.requestMeta?.requestId!==pending.id || body.requestMeta.handler!==handler) throw Error();
        this.finish(null,body);
      } catch (_) {this.finish(fail('INVALID_JSON_RESPONSE'));}
    }
    async call(action,fields,id,deadline) {
      if (!validFields(action,fields) || !/^lpbridge-[a-f0-9]{32}$/.test(id)) throw fail('BRIDGE_ACTION_BLOCKED');
      const payload={...fields};
      await this.ready;
      if (this.closed) throw fail('BRIDGE_CLOSED');
      if (this.pending) throw fail('BRIDGE_BUSY');
      const remaining=deadline-Date.now();
      if (remaining<=0) throw fail('REQUEST_TIMEOUT');
      return new Promise((resolve,reject)=>{
        this.pending={id,action,resolve,reject,timer:setTimeout(()=>{this.finish(fail('REQUEST_TIMEOUT'));this.close();},remaining)};
        try {this.peer.postMessage({type:'lp-bridge-call',action,fields:payload,requestId:id,channel:this.channel},this.peerOrigin);}
        catch (_) {this.finish(fail('NETWORK_ERROR'));this.close();}
      });
    }
    finish(error,result) {
      const pending=this.pending;if(!pending)return;
      clearTimeout(pending.timer);this.pending=null;
      if(error){error.requestId=pending.id;pending.reject(error);}else pending.resolve(result);
    }
    close() {
      if(this.closed)return;this.closed=true;clearTimeout(this.readyTimer);
      window.removeEventListener('message',this.onMessage);this.rejectReady(fail('BRIDGE_CLOSED'));this.finish(fail('BRIDGE_CLOSED'));
      this.peer=null;this.iframe.remove();
    }
  }
  const lane=()=>({tail:Promise.resolve(),pending:0,client:null});
  const groups={public:[lane()],auth:[lane(),lane()]};
  let generation=0;
  const enabled=()=>window.LUOPANICH_CONFIG?.READ_TRANSPORT==='IFRAME_RPC_V1';
  function connect(lane,timeout) {
    const iframe=document.createElement('iframe');iframe.hidden=true;iframe.title='Luopanich connection';document.body.append(iframe);
    try {lane.client=new Client(iframe,window.LUOPANICH_CONFIG.BRIDGE_API_BASE_URL || window.LUOPANICH_CONFIG.API_BASE_URL,timeout);}
    catch(error){iframe.remove();throw error;}
    return lane.client;
  }
  function prepareLogin() {
    if(!enabled())return;
    const lane=groups.auth[0];if(lane.client&&!lane.client.closed)return;
    try {const client=connect(lane,30000);client.ready.catch(()=>client.close());}catch(_){}
  }
  async function request(action,fields,id,timeout) {
    if(!enabled()||!validFields(action,fields))throw fail('BRIDGE_ACTION_BLOCKED');
    const started=Date.now();
    const requestGeneration=generation;
    const deadline=started+Math.min(65000,Math.max(1,Number(timeout)||30000));
    const lanes=groups[['products','getBrandSettings'].includes(action)?'public':'auth'];
    const lane=lanes.reduce((a,b)=>a.pending<=b.pending?a:b);
    const payload={...fields};lane.pending++;
    // Queue time and handshake time share the caller's deadline. Never replay a call here.
    let timer;
    const expire=new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('REQUEST_TIMEOUT')),Math.max(1,deadline-Date.now()));});
    const operation=lane.tail.then(async()=>{
      if(requestGeneration!==generation)throw fail('BRIDGE_CLOSED');
      if(Date.now()>=deadline)throw fail('REQUEST_TIMEOUT');
      if(!lane.client||lane.client.closed)connect(lane,deadline-Date.now());
      try {return await lane.client.call(action,payload,id,deadline);}
      catch(error){lane.client.close();throw error;}
    });
    lane.tail=operation.catch(()=>{}).finally(()=>{lane.pending--;});
    try {
      const body=await Promise.race([operation,expire]);
      if(window.LUOPANICH_CONFIG.REQUEST_DIAGNOSTICS===true)console.info('[Luopanich bridge] '+JSON.stringify({action,requestId:id,elapsedMs:Date.now()-started,serverMs:body.requestMeta?.serverMs||0,handler:body.requestMeta?.handler,result:body.success===true?'SUCCESS':'REJECTED'}));
      return body;
    }finally{clearTimeout(timer);}
  }
  window.LuopanichBridge=Object.freeze({
    enabled,allows:action=>enabled()&&actions.includes(action),prepareLogin,
    nextId:()=> 'lpbridge-'+Client.randomHex(16),
    public:(action,id,timeout)=>request(action,action==='products'?{includeBrandSettings:'1'}:{},id,timeout),
    post:(form,id,timeout)=>{
      const fields={},seen=new Set();let action='';
      for(const [key,value] of form.entries()) {
        if(typeof value!=='string'||seen.has(key))return Promise.reject(fail('BRIDGE_ACTION_BLOCKED'));
        seen.add(key);
        if(key==='action')action=value;else Object.defineProperty(fields,key,{value,enumerable:true});
      }
      return request(action,fields,id,timeout);
    }
  });
  window.addEventListener('pagehide',()=>{generation++;Object.values(groups).flat().forEach(lane=>lane.client?.close());});
})();
