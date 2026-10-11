/* store.js – sdílená datová vrstva pro admin.html a warehouse.html.
   Stejné klíče (ecs.v1.*), ID, stavy a tabulka přechodů jako mini-eshop.html.
   Demo data nahrává mini-eshop.html (seed zde záměrně není).
   Role jsou jen simulace oprávnění, ne bezpečnost. */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>(c/100).toLocaleString('cs-CZ',{maximumFractionDigits:2})+' Kč';
const fmtDate=s=>s?new Date(s).toLocaleString('cs-CZ'):'–';

const Store=(()=>{
const P='ecs.v1.';
const FMT={product:['PRD-',4],variant:['VAR-',4],customer:['CUS-',4],order:['ORD-',6],task:['TSK-',4],batch:['BAT-',4],movement:['MOV-',6],shipment:['SHP-',4],event:['EVT-',6]};
const STATUS={NEW:'Nová',AWAITING_PAYMENT:'Čeká na platbu',PAID:'Zaplacená',HANDED_TO_WAREHOUSE:'Předaná skladu',PICKING:'Vychystává se',PACKED:'Vychystaná / zabalená',SHIPPED:'Odeslaná',DELIVERED:'Doručená',CANCELLED:'Stornovaná',RETURN_REQUESTED:'Žádost o vrácení',RETURNED:'Vrácená'};
const TR=[['NEW','AWAITING_PAYMENT','customer'],['AWAITING_PAYMENT','PAID','customer'],['PAID','HANDED_TO_WAREHOUSE','admin'],['HANDED_TO_WAREHOUSE','PICKING','warehouse'],['PICKING','PACKED','warehouse'],['PACKED','SHIPPED','warehouse'],['SHIPPED','DELIVERED','admin'],['DELIVERED','RETURN_REQUESTED','customer,admin'],['RETURN_REQUESTED','RETURNED','warehouse'],['NEW','CANCELLED','customer,admin'],['AWAITING_PAYMENT','CANCELLED','customer,admin'],['PAID','CANCELLED','customer,admin'],['HANDED_TO_WAREHOUSE','CANCELLED','admin']];
const now=()=>new Date().toISOString();
const rd=(k,d)=>{try{const v=localStorage.getItem(P+k);return v?JSON.parse(v):d}catch(e){return d}};
const wr=(k,v)=>localStorage.setItem(P+k,JSON.stringify(v));
const subs=[];let timer=0;
const fire=()=>{clearTimeout(timer);timer=setTimeout(()=>subs.forEach(f=>f()),40)};
const bc='BroadcastChannel' in window?new BroadcastChannel('ecs'):null;
if(bc)bc.onmessage=fire;
addEventListener('storage',e=>{if(e.key&&e.key.startsWith(P)&&!e.key.includes('session.'))fire()});
const notify=()=>{fire();bc&&bc.postMessage('chg')};
const fail=(code,message,data)=>{throw Object.assign(new Error(message),{code,data})};

/* Příkaz = jedna transakce: načíst → ověřit → zapsat vše → událost → notifikace. Při chybě se nezapíše nic. */
function tx(fn){
  const cache={};
  const t={
    get(k){if(!(k in cache))cache[k]=rd(k,k==='counters'?{}:[]);return cache[k]},
    id(type){const c=t.get('counters');c[type]=(c[type]||0)+1;return FMT[type][0]+String(c[type]).padStart(FMT[type][1],'0')},
    ev(type,entity,payload,actor){t.get('events').push({id:t.id('event'),type,entity,actor,at:now(),payload})},
    mov(m){t.get('movements').push({id:t.id('movement'),at:now(),...m})}
  };
  try{const data=fn(t);Object.keys(cache).forEach(k=>wr(k,cache[k]));notify();return{ok:true,data}}
  catch(e){
    if(e.code)return{ok:false,code:e.code,message:e.message,data:e.data};
    if(e.name==='QuotaExceededError')return{ok:false,code:'STORAGE_FULL',message:'Úložiště je plné.'};
    throw e;
  }
}
function transition(t,o,to,role,actor,reason){
  const from=o.status,r=TR.find(x=>x[0]===from&&x[1]===to);
  if(!r)fail('INVALID_TRANSITION',`Přechod ${from} → ${to} není povolen.`);
  if(!r[2].split(',').includes(role))fail('FORBIDDEN',`Role ${role} nesmí provést ${from} → ${to}.`);
  const at=now();
  o.statusHistory.push({from,to,at,actor,reason});o.status=to;o.rev++;o.updatedAt=at;
  t.ev('order.'+to.toLowerCase(),{type:'order',id:o.id},{from,to},actor);
}
const find=(t,col,id,label)=>{const x=t.get(col).find(y=>y.id===id);if(!x)fail('NOT_FOUND',label+' neexistuje.');return x};
const U=s=>String(s||'').trim();

const cmd={
  /* ADMIN: PAID → HANDED_TO_WAREHOUSE + vznik skladové úlohy */
  handToWarehouse(orderId,user){return tx(t=>{
    const o=find(t,'orders',orderId,'Objednávka'),actor={app:'admin',user:U(user)||'admin'};
    transition(t,o,'HANDED_TO_WAREHOUSE','admin',actor,'Předáno skladu');
    if(!o.reservations||!o.reservations.length)fail('NO_RESERVATION','Objednávka nemá rezervaci zásoby.');
    const a=o.customerSnapshot&&o.customerSnapshot.address;
    if(!a||!a.street||!a.city)fail('NO_ADDRESS','Objednávka nemá vyplněnou adresu.');
    const task={id:t.id('task'),orderId:o.id,type:'FULFILL',status:'OPEN',batchId:null,assignee:null,
      lines:o.reservations.map(r=>({variantId:r.variantId,locationId:r.locationId,qtyRequired:r.qty,qtyPicked:0})),createdAt:now(),rev:1};
    t.get('tasks').push(task);t.ev('task.created',{type:'task',id:task.id},{orderId:o.id},actor);
    return task;
  })},
  /* ADMIN (nebo zákazník přes e-shop): storno, uvolní rezervaci a zruší úlohu */
  cancelOrder(orderId,reason,role,user){return tx(t=>{
    const o=find(t,'orders',orderId,'Objednávka'),prev=o.status,actor={app:role==='admin'?'admin':'eshop',user:U(user)||role};
    transition(t,o,'CANCELLED',role,actor,reason||'Storno');
    const stock=t.get('stock');
    (o.reservations||[]).forEach(r=>{
      const s=stock.find(x=>x.variantId===r.variantId&&x.locationId===r.locationId);if(s)s.reserved-=r.qty;
      t.mov({type:'RELEASE',variantId:r.variantId,locationId:r.locationId,qty:r.qty,refType:'ORDER',refId:o.id,reason:'Storno',actor});
    });
    o.reservations=[];if(o.payment.status==='PAID')o.payment.status='REFUNDED';
    if(prev==='HANDED_TO_WAREHOUSE'){
      const tk=t.get('tasks').find(x=>x.orderId===o.id&&x.status!=='CANCELLED');
      if(tk){tk.status='CANCELLED';tk.rev++;
        const b=tk.batchId&&t.get('batches').find(x=>x.id===tk.batchId);
        if(b){ // vyjmout z neprobíhajícího batche
          b.taskIds=b.taskIds.filter(i=>i!==tk.id);
          b.lines.forEach(l=>{l.allocations=l.allocations.filter(a=>{if(a.taskId===tk.id){l.qtyRequired-=a.qty;return false}return true})});
          b.lines=b.lines.filter(l=>l.qtyRequired>0);b.rev++;if(!b.taskIds.length)b.status='CANCELLED';
        }}
    }
    return o;
  })},
  /* WAREHOUSE: batch ze skladových úloh (sloučí stejné varianty na stejné pozici, seřadí podle pozice) */
  createBatch(taskIds,user){return tx(t=>{
    if(!Array.isArray(taskIds)||!taskIds.length)fail('EMPTY','Vyberte aspoň jednu objednávku.');
    const tasks=[...new Set(taskIds)].map(id=>find(t,'tasks',id,'Úloha'));
    tasks.forEach(k=>{if(k.status!=='OPEN')fail('TASK_NOT_OPEN',`Úloha ${k.id} už není volná.`)});
    const map={};
    tasks.forEach(k=>k.lines.forEach((l,i)=>{
      const key=l.variantId+'|'+l.locationId;
      const x=map[key]||(map[key]={key,variantId:l.variantId,locationId:l.locationId,qtyRequired:0,qtyPicked:0,allocations:[]});
      x.qtyRequired+=l.qtyRequired;x.allocations.push({taskId:k.id,lineIdx:i,qty:l.qtyRequired});
    }));
    const lines=Object.values(map).sort((a,b)=>a.locationId.localeCompare(b.locationId)||a.variantId.localeCompare(b.variantId));
    const actor={app:'warehouse',user:U(user)||'sklad'};
    const b={id:t.id('batch'),status:'OPEN',taskIds:tasks.map(k=>k.id),lines,assignee:null,createdAt:now(),rev:1};
    tasks.forEach(k=>{k.status='BATCHED';k.batchId=b.id;k.rev++});
    t.get('batches').push(b);t.ev('batch.created',{type:'batch',id:b.id},{tasks:b.taskIds},actor);
    return b;
  })},
  /* WAREHOUSE: zahájení picku → objednávky HANDED_TO_WAREHOUSE → PICKING */
  startBatch(batchId,user){return tx(t=>{
    const b=find(t,'batches',batchId,'Batch'),u=U(user);
    if(!u)fail('NO_USER','Zadejte jméno skladníka.');
    if(b.status!=='OPEN')fail('BATCH_NOT_OPEN','Batch už byl zahájen nebo uzavřen.');
    const actor={app:'warehouse',user:u};
    b.status='IN_PROGRESS';b.assignee=u;b.startedAt=now();b.rev++;
    b.taskIds.forEach(id=>{
      const k=find(t,'tasks',id,'Úloha');k.status='PICKING';k.assignee=u;k.rev++;
      transition(t,find(t,'orders',k.orderId,'Objednávka'),'PICKING','warehouse',actor,'Zahájen picking '+b.id);
    });
    t.ev('batch.started',{type:'batch',id:b.id},{},actor);return b;
  })},
  /* WAREHOUSE: sken pozice + EAN + množství. Bez změny onHand (ta se mění až při expedici). */
  pick(batchId,key,location,ean,qty,user){return tx(t=>{
    const b=find(t,'batches',batchId,'Batch'),actor={app:'warehouse',user:U(user)||b.assignee};
    if(b.status!=='IN_PROGRESS')fail('BATCH_NOT_ACTIVE','Batch není ve stavu picking.');
    const l=b.lines.find(x=>x.key===key);if(!l)fail('NO_LINE','Řádek batche neexistuje.');
    if(U(location).toUpperCase()!==l.locationId.toUpperCase())fail('WRONG_LOCATION','Špatná pozice. Očekává se '+l.locationId+'.');
    const v=find(t,'variants',l.variantId,'Varianta');
    if(U(ean)!==v.ean)fail('WRONG_EAN','EAN neodpovídá očekávanému produktu.');
    const n=Number(qty);
    if(!Number.isInteger(n)||n<1)fail('BAD_QTY','Zadejte celé číslo větší než 0.');
    const rem=l.qtyRequired-l.qtyPicked;
    if(n>rem)fail('QTY_EXCEEDS','Zbývá vychystat jen '+rem+' ks.');
    let left=n;
    l.allocations.forEach(a=>{
      const k=find(t,'tasks',a.taskId,'Úloha'),tl=k.lines[a.lineIdx],take=Math.min(left,tl.qtyRequired-tl.qtyPicked);
      if(take>0){tl.qtyPicked+=take;left-=take;k.rev++}
    });
    l.qtyPicked+=n;b.rev++;
    t.mov({type:'PICK',variantId:l.variantId,locationId:l.locationId,qty:n,refType:'BATCH',refId:b.id,reason:'Ověřeno skenem',actor});
    return l;
  })},
  /* WAREHOUSE: dokončení picku; vše musí být vychystáno, objednávky PICKING → PACKED */
  completeBatch(batchId,user){return tx(t=>{
    const b=find(t,'batches',batchId,'Batch'),actor={app:'warehouse',user:U(user)||b.assignee};
    if(b.status!=='IN_PROGRESS')fail('BATCH_NOT_ACTIVE','Batch není ve stavu picking.');
    if(b.lines.some(l=>l.qtyPicked!==l.qtyRequired))fail('PICK_INCOMPLETE','Nejsou vychystány všechny položky.');
    b.taskIds.forEach(id=>{
      const k=find(t,'tasks',id,'Úloha');k.status='PICKED';k.rev++;
      transition(t,find(t,'orders',k.orderId,'Objednávka'),'PACKED','warehouse',actor,'Picking dokončen '+b.id);
    });
    b.status='DONE';b.completedAt=now();b.rev++;
    t.ev('batch.completed',{type:'batch',id:b.id},{},actor);return b;
  })}
};
const G={
  ready:()=>!!rd('meta',null),
  col:k=>rd(k,[]),
  available:vid=>rd('stock',[]).filter(s=>s.variantId===vid).reduce((a,s)=>a+s.onHand-s.reserved,0),
  variant:vid=>rd('variants',[]).find(v=>v.id===vid),
  vname(vid){
    const v=G.variant(vid);if(!v)return vid;
    const p=rd('products',[]).find(x=>x.id===v.productId),a=[v.attrs.color,v.attrs.size].filter(Boolean).join(' / ');
    return(p?p.name:v.productId)+(a?' – '+a:'');
  }
};
const session={get(){const s=rd('session.warehouse',{})||{};return{user:typeof s.user==='string'?s.user:''}},set(v){wr('session.warehouse',v)}};
return{subscribe:f=>subs.push(f),get:G,cmd,session,STATUS,TR};
})();
