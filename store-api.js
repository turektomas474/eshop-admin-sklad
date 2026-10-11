/* store-api.js – náhrada store.js pro admin a sklad.
   Má stejné rozhraní (Store.get.col, Store.cmd.*, Store.subscribe...), ale data bere ze serveru (PostgreSQL),
   ne z localStorage. Data se načítají každé 4 s a po každé akci. */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>(c/100).toLocaleString('cs-CZ',{maximumFractionDigits:2})+' Kč';
const fmtDate=s=>s?new Date(s).toLocaleString('cs-CZ'):'–';

const Store=(()=>{
const API='http://localhost:3000';
const STATUS={NEW:'Nová',AWAITING_PAYMENT:'Čeká na platbu',PAID:'Zaplacená',HANDED_TO_WAREHOUSE:'Předaná skladu',PICKING:'Vychystává se',PACKED:'Vychystaná / zabalená',SHIPPED:'Odeslaná',DELIVERED:'Doručená',CANCELLED:'Stornovaná',RETURN_REQUESTED:'Žádost o vrácení',RETURNED:'Vrácená'};
let data=null,err='';
const subs=[];
const fire=()=>subs.forEach(f=>f());

async function refresh(){
  try{
    const r=await fetch(API+'/api/admin/snapshot');
    if(!r.ok)throw new Error('API '+r.status);
    const j=await r.json();
    const same=data&&JSON.stringify(j)===JSON.stringify(data);
    data=j;err='';
    if(!same)fire();
  }catch(e){
    const msg='Server není dostupný. Běží backend (node server.js)?';
    if(err!==msg){err=msg;fire()}
  }
}
async function call(url,body){
  try{
    const r=await fetch(API+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j=await r.json();
    await refresh();
    return r.ok?{ok:true,data:j}:{ok:false,code:j.code,message:j.message,data:j.data};
  }catch(e){return{ok:false,code:'NETWORK',message:'Server není dostupný.'}}
}

const cmd={
  handToWarehouse:(orderId,user)=>call('/api/admin/orders/'+encodeURIComponent(orderId)+'/hand',{user}),
  cancelOrder:(orderId,reason,role,user)=>call('/api/admin/orders/'+encodeURIComponent(orderId)+'/cancel',{reason,user}),
  createBatch:(taskIds,user)=>call('/api/warehouse/batches',{taskIds,user}),
  startBatch:(batchId,user)=>call('/api/warehouse/batches/'+encodeURIComponent(batchId)+'/start',{user}),
  pick:(batchId,key,location,ean,qty,user)=>call('/api/warehouse/batches/'+encodeURIComponent(batchId)+'/pick',{key,location,ean,qty,user}),
  completeBatch:(batchId,user)=>call('/api/warehouse/batches/'+encodeURIComponent(batchId)+'/complete',{user})
};

const G={
  ready:()=>!!data,
  error:()=>err,
  col:k=>(data&&data[k])||[],
  available:vid=>G.col('stock').filter(s=>s.variantId===vid).reduce((a,s)=>a+s.onHand-s.reserved,0),
  variant:vid=>G.col('variants').find(v=>v.id===vid),
  vname(vid){
    const v=G.variant(vid);if(!v)return vid;
    const p=G.col('products').find(x=>x.id===v.productId),a=Object.values(v.attrs||{}).join(' / ');
    return(p?p.name:v.productId)+(a?' – '+a:'');
  }
};
// jméno skladníka si pamatuje jen prohlížeč (pohodlí, ne bezpečnost)
const SK='ecs.v1.session.warehouse';
const session={
  get(){try{const s=JSON.parse(localStorage.getItem(SK)||'{}')||{};return{user:typeof s.user==='string'?s.user:''}}catch(e){return{user:''}}},
  set(v){try{localStorage.setItem(SK,JSON.stringify(v))}catch(e){}}
};
setInterval(refresh,4000);
addEventListener('focus',refresh);
refresh();
return{subscribe:f=>subs.push(f),get:G,cmd,session,STATUS};
})();
