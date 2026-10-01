(() => {
  'use strict';
  const fault = code => Object.assign(new Error(code), {code, serverRejected:true});
  function createJournal({indexedDB, name = 'luopanich-stock-journal-v1', timeoutMs = 5000} = {}) {
    let opening = null;
    const key = (scope, id) => JSON.stringify([scope, id]);
    function normalize(scope, input) {
      if (typeof scope !== 'string' || !scope || scope.length > 2048 || !input ||
          !['stockIn','stockAdjust','batchStockIn'].includes(input.action) ||
          typeof input.id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(input.id) ||
          !Array.isArray(input.items) || !input.items.length || input.items.length > 2000 ||
          (input.action !== 'batchStockIn' && input.items.length !== 1)) throw fault('STOCK_JOURNAL_INVALID');
      const items = input.items.map(item => {
        if (!item || typeof item.productId !== 'string' || !item.productId.trim() ||
            item.productId !== item.productId.trim() || item.productId.length > 256 ||
            !Number.isSafeInteger(item.qty) || item.qty < (input.action === 'stockAdjust' ? 0 : 1)) throw fault('STOCK_JOURNAL_INVALID');
        return {productId:item.productId, qty:item.qty};
      });
      if (new Set(items.map(item => item.productId)).size !== items.length) throw fault('STOCK_JOURNAL_INVALID');
      // Deliberately exclude token, password, notes and executable callbacks.
      return {key:key(scope,input.id), scope, version:1, id:input.id, action:input.action, items, createdAt:input.createdAt};
    }
    function validateStored(scope, record) {
      const clean = normalize(scope,record);
      if (record.scope !== scope || record.key !== clean.key || record.version !== 1 ||
          !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
          Object.keys(record).sort().join(',') !== 'action,createdAt,id,items,key,scope,version') throw fault('STOCK_JOURNAL_CORRUPT');
      return clean;
    }
    function open() {
      if (opening) return opening;
      const job = new Promise((resolve,reject) => {
        if (!indexedDB) { reject(fault('STOCK_JOURNAL_UNAVAILABLE')); return; }
        let settled = false, request;
        const timer = setTimeout(() => finish(fault('STOCK_JOURNAL_UNAVAILABLE')), timeoutMs);
        function finish(error,db) {
          if (settled) { if(db)db.close(); return; }
          settled=true; clearTimeout(timer); if(error)reject(error);else resolve(db);
        }
        try { request=indexedDB.open(name,1); } catch (_) {finish(fault('STOCK_JOURNAL_UNAVAILABLE'));return;}
        request.onupgradeneeded=()=>{const store=request.result.createObjectStore('pending',{keyPath:'key'});store.createIndex('scope','scope');};
        request.onerror=()=>finish(fault('STOCK_JOURNAL_UNAVAILABLE'));
        request.onblocked=()=>finish(fault('STOCK_JOURNAL_UNAVAILABLE'));
        request.onsuccess=()=>{
          const db=request.result;db.onversionchange=()=>{db.close();opening=null;};finish(null,db);
        };
      });
      opening=job;job.catch(()=>{if(opening===job)opening=null;});return job;
    }
    async function transaction(scope, mode, visit) {
      if (typeof scope !== 'string' || !scope || scope.length > 2048) throw fault('STOCK_JOURNAL_INVALID');
      const db=await open();
      return new Promise((resolve,reject)=>{
        let tx,result,error,timer;
        try {
          tx=db.transaction('pending',mode,{durability:'strict'});
          timer=setTimeout(()=>{error=fault('STOCK_JOURNAL_UNAVAILABLE');try{tx.abort();}catch(_){}reject(error);},timeoutMs);
          tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};
          tx.onabort=()=>{clearTimeout(timer);reject(error || fault('STOCK_JOURNAL_UNAVAILABLE'));};
          tx.onerror=()=>{error=error || fault('STOCK_JOURNAL_UNAVAILABLE');};
          const store=tx.objectStore('pending'),request=store.index('scope').getAll(scope);
          request.onsuccess=()=>{
            try {result=visit(store,request.result.map(row=>validateStored(scope,row)));}
            catch(caught){error=caught;tx.abort();}
          };
        } catch (_) {clearTimeout(timer);reject(fault('STOCK_JOURNAL_UNAVAILABLE'));}
      });
    }
    return Object.freeze({
      list:scope=>transaction(scope,'readonly',(_,rows)=>rows.sort((a,b)=>a.createdAt-b.createdAt)),
      reserve:async(scope,input)=>{
        const entry=normalize(scope,{...input,createdAt:Date.now()});
        return transaction(scope,'readwrite',(store,rows)=>{
          const products=new Set(entry.items.map(item=>item.productId));
          if(rows.some(row=>row.id===entry.id || row.items.some(item=>products.has(item.productId)))) throw fault('STOCK_JOURNAL_PENDING');
          if(rows.length>=100)throw fault('STOCK_JOURNAL_FULL');
          store.add(entry);return entry;
        });
      },
      settle:(scope,id)=>transaction(scope,'readwrite',(store)=>{store.delete(key(scope,id));}),
      close:async()=>{if(opening){const db=await opening;db.close();opening=null;}}
    });
  }
  window.LuopanichStockJournal=Object.freeze({create:createJournal});
})();
