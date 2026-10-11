'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Check,Edit3,Plus,RefreshCw,Save,ShieldCheck} from 'lucide-react';

type Opportunity={id:string;title:string;category:string;description:string;assetSymbol:string|null;minimumAmount:string;maximumAmount:string|null;targetReturnPercent:string|null;durationDays:number;startsAt:string|null;maturesAt:string|null;riskLevel:string;status:string;demoEligible:boolean;realEligible:boolean;requiresApproval:boolean;targetPrice:string|null;stopPrice:string|null;_count:{requests:number}};
type InvestmentRequest={id:string;userId:string;accountMode:'DEMO'|'REAL';amount:string;status:string;requestedAt:string;durationDays:number;externalExecutionReference:string|null;settlementReference:string|null;simulatedPayout:string|null;adminNote:string|null;user:{email:string;name:string|null};opportunity:{title:string;category:string;riskLevel:string;durationDays:number}};
type Data={opportunities:Opportunity[];requests:InvestmentRequest[]};
type Draft={title:string;category:string;description:string;assetSymbol:string;minimumAmount:string;maximumAmount:string;targetReturnPercent:string;durationDays:string;startsAt:string;maturesAt:string;riskLevel:string;status:string;demoEligible:boolean;realEligible:boolean;requiresApproval:boolean;targetPrice:string;stopPrice:string};
type RequestControls={note:string;executionReference:string;settlementReference:string;simulatedPayout:string};

const emptyDraft:Draft={title:'',category:'',description:'',assetSymbol:'',minimumAmount:'100',maximumAmount:'',targetReturnPercent:'',durationDays:'30',startsAt:'',maturesAt:'',riskLevel:'MODERATE',status:'DRAFT',demoEligible:true,realEligible:false,requiresApproval:true,targetPrice:'',stopPrice:''};
const statuses=['DRAFT','AVAILABLE','PAUSED','CLOSED'];
const currency=(value:string|null)=>value===null?'No limit':`$${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;

function localDate(value:string|null){return value?new Date(value).toISOString().slice(0,10):'';}
function toOptionalNumber(value:string){return value.trim()===''?null:Number(value);}
function controlsFor(item:InvestmentRequest):RequestControls{return {note:item.adminNote||'',executionReference:item.externalExecutionReference||'',settlementReference:item.settlementReference||'',simulatedPayout:''};}

export default function AdminInvestmentPanel(){
 const [data,setData]=useState<Data>({opportunities:[],requests:[]});const [draft,setDraft]=useState<Draft>(emptyDraft);const [editingId,setEditingId]=useState('');const [controls,setControls]=useState<Record<string,RequestControls>>({});const [loading,setLoading]=useState(true);const [busy,setBusy]=useState('');const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const load=useCallback(async(showLoading=false)=>{if(showLoading)setLoading(true);try{const response=await fetch('/api/admin/investments',{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load investment operations.');setData(result);setControls(current=>{const next={...current};for(const item of result.requests)if(!next[item.id])next[item.id]=controlsFor(item);return next;});setError('');}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load investment operations.');}finally{if(showLoading)setLoading(false);}},[]);
 useEffect(()=>{void load(true);},[load]);

 function editOpportunity(item:Opportunity){setEditingId(item.id);setDraft({title:item.title,category:item.category,description:item.description,assetSymbol:item.assetSymbol||'',minimumAmount:item.minimumAmount,maximumAmount:item.maximumAmount||'',targetReturnPercent:item.targetReturnPercent||'',durationDays:String(item.durationDays),startsAt:localDate(item.startsAt),maturesAt:localDate(item.maturesAt),riskLevel:item.riskLevel,status:item.status,demoEligible:item.demoEligible,realEligible:item.realEligible,requiresApproval:item.requiresApproval,targetPrice:item.targetPrice||'',stopPrice:item.stopPrice||''});setNotice('Opportunity terms loaded for editing.');}

 async function saveOpportunity(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;setBusy('opportunity');setError('');setNotice('');
  const payload={title:draft.title,category:draft.category,description:draft.description,assetSymbol:draft.assetSymbol||null,minimumAmount:Number(draft.minimumAmount),maximumAmount:toOptionalNumber(draft.maximumAmount),targetReturnPercent:toOptionalNumber(draft.targetReturnPercent),durationDays:Number(draft.durationDays),startsAt:draft.startsAt?new Date(`${draft.startsAt}T00:00:00.000Z`).toISOString():null,maturesAt:draft.maturesAt?new Date(`${draft.maturesAt}T00:00:00.000Z`).toISOString():null,riskLevel:draft.riskLevel,status:draft.status,demoEligible:draft.demoEligible,realEligible:draft.realEligible,requiresApproval:draft.requiresApproval,targetPrice:toOptionalNumber(draft.targetPrice),stopPrice:toOptionalNumber(draft.stopPrice)};
  try{
   const response=await fetch('/api/admin/investments',{method:editingId?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editingId?{action:'update-opportunity',id:editingId,...payload}:payload)});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save opportunity.');
   setNotice(editingId?'Opportunity updated.':'Opportunity created.');setDraft(emptyDraft);setEditingId('');await load();
  }catch(exception){setError(exception instanceof Error?exception.message:'Unable to save opportunity.');}
  finally{setBusy('');}
 }

 async function transition(item:InvestmentRequest,action:string){
  const detail=controls[item.id]||controlsFor(item);const key=`${item.id}:${action}`;if(busy)return;setBusy(key);setError('');setNotice('');
  const body:{action:string;requestId:string;note?:string;executionReference?:string;settlementReference?:string;simulatedPayout?:number}={action,requestId:item.id,note:detail.note||undefined};
  if(action==='activate'&&detail.executionReference.trim())body.executionReference=detail.executionReference.trim();
  if(action==='settle'){
   if(detail.settlementReference.trim())body.settlementReference=detail.settlementReference.trim();
   if(item.accountMode==='DEMO'&&detail.simulatedPayout.trim()!=='')body.simulatedPayout=Number(detail.simulatedPayout);
  }
  try{const response=await fetch('/api/admin/investments',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update this request.');setNotice(`Request moved to ${result.status.replaceAll('_',' ')}.`);await load();}
  catch(exception){setError(exception instanceof Error?exception.message:'Unable to update this request.');}
  finally{setBusy('');}
 }

 function updateControls(id:string,key:keyof RequestControls,value:string){setControls(current=>({...current,[id]:{...(current[id]||{note:'',executionReference:'',settlementReference:'',simulatedPayout:''}),[key]:value}}));}
 function actionsFor(status:string){if(status==='PENDING_APPROVAL')return ['approve','reject'];if(status==='APPROVED')return ['activate','cancel'];if(status==='ACTIVE')return ['pause','complete','cancel'];if(status==='PAUSED')return ['activate','complete','cancel'];if(status==='COMPLETED')return ['settle'];return [];}
 const pending=data.requests.filter(item=>item.status==='PENDING_APPROVAL').length;const active=data.requests.filter(item=>item.status==='ACTIVE'||item.status==='PAUSED').length;

 return <div className="admin-investments">
  <div className="account-heading"><div><span className="account-kicker">OPERATIONS · INVESTMENTS</span><h1>Investment control</h1><p>Configure terms, review requests, and record lifecycle decisions.</p></div><button className="icon-action" type="button" aria-label="Refresh investment data" onClick={()=>void load(true)}><RefreshCw size={15}/></button></div>
  {notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<div className="account-callout mb-3" role="alert"><span>{error}</span><button className="text-link" type="button" onClick={()=>void load(true)}>Retry</button></div>}
  <section className="admin-investment-metrics"><article><span>Opportunities</span><b>{data.opportunities.length}</b></article><article><span>Awaiting review</span><b>{pending}</b></article><article><span>Active / paused</span><b>{active}</b></article><article><span>Requests recorded</span><b>{data.requests.length}</b></article></section>
  <div className="admin-investment-columns">
   <section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{editingId?'Edit opportunity':'Create opportunity'}</h2><p className="account-panel-subtitle">Targets are projections. REAL approval does not execute or settle funds.</p></div></div>
    <form className="admin-investment-form" onSubmit={event=>void saveOpportunity(event)}>
     <label className="account-label">Title<input className="input" required minLength={3} maxLength={120} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
     <label className="account-label">Category<input className="input" required minLength={2} maxLength={80} value={draft.category} onChange={event=>setDraft({...draft,category:event.target.value})}/></label>
     <label className="account-label">Asset symbol (optional)<input className="input" maxLength={30} value={draft.assetSymbol} onChange={event=>setDraft({...draft,assetSymbol:event.target.value.toUpperCase()})}/></label>
     <label className="account-label">Risk level<select className="input" value={draft.riskLevel} onChange={event=>setDraft({...draft,riskLevel:event.target.value})}>{['LOW','MODERATE','HIGH','VERY_HIGH'].map(item=><option key={item}>{item}</option>)}</select></label>
     <label className="account-label">Minimum (USD)<input className="input" type="number" min="0.01" step="0.01" required value={draft.minimumAmount} onChange={event=>setDraft({...draft,minimumAmount:event.target.value})}/></label>
     <label className="account-label">Maximum (optional)<input className="input" type="number" min="0.01" step="0.01" value={draft.maximumAmount} onChange={event=>setDraft({...draft,maximumAmount:event.target.value})}/></label>
     <label className="account-label">Target return % (projection)<input className="input" type="number" step="0.01" value={draft.targetReturnPercent} onChange={event=>setDraft({...draft,targetReturnPercent:event.target.value})}/></label>
     <label className="account-label">Duration (days)<input className="input" type="number" min="1" max="3650" required value={draft.durationDays} onChange={event=>setDraft({...draft,durationDays:event.target.value})}/></label>
     <label className="account-label">Start date<input className="input" type="date" value={draft.startsAt} onChange={event=>setDraft({...draft,startsAt:event.target.value})}/></label>
     <label className="account-label">Maturity date<input className="input" type="date" value={draft.maturesAt} onChange={event=>setDraft({...draft,maturesAt:event.target.value})}/></label>
     <label className="account-label">Target reference price<input className="input" type="number" min="0.000001" step="any" value={draft.targetPrice} onChange={event=>setDraft({...draft,targetPrice:event.target.value})}/></label>
     <label className="account-label">Stop reference price<input className="input" type="number" min="0.000001" step="any" value={draft.stopPrice} onChange={event=>setDraft({...draft,stopPrice:event.target.value})}/></label>
     <label className="account-label">Availability<select className="input" value={draft.status} onChange={event=>setDraft({...draft,status:event.target.value})}>{statuses.map(item=><option key={item}>{item}</option>)}</select></label>
     <label className="account-label md:col-span-2">Description<textarea className="input min-h-24" required minLength={10} maxLength={3000} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
     <div className="admin-investment-checks"><label><input type="checkbox" checked={draft.demoEligible} onChange={event=>setDraft({...draft,demoEligible:event.target.checked})}/> DEMO eligible</label><label><input type="checkbox" checked={draft.realEligible} onChange={event=>setDraft({...draft,realEligible:event.target.checked})}/> REAL requests eligible</label><label><input type="checkbox" checked={draft.requiresApproval} onChange={event=>setDraft({...draft,requiresApproval:event.target.checked})}/> Require approval</label></div>
     {draft.realEligible&&<p className="admin-investment-warning md:col-span-2"><ShieldCheck size={15}/> REAL eligibility enables requests only. No external trading, payment, or settlement is connected.</p>}
     <div className="flex flex-wrap gap-2 md:col-span-2"><button className="btn bg-gold text-black" disabled={busy==='opportunity'}>{busy==='opportunity'?'Saving…':editingId?<><Save size={15}/> Save changes</>:<><Plus size={15}/> Create opportunity</>}</button>{editingId&&<button className="btn bg-white/5" type="button" onClick={()=>{setEditingId('');setDraft(emptyDraft);}}>Cancel edit</button>}</div>
    </form>
   </section>
   <section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Opportunities</h2><p className="account-panel-subtitle">Products are retained for request history; close instead of deleting.</p></div></div>
    {loading&&!data.opportunities.length?<p className="account-empty" role="status">Loading opportunities…</p>:data.opportunities.length?<div className="admin-opportunity-list">{data.opportunities.map(item=><article key={item.id}><div><b>{item.title}</b><span>{item.category} · {item.riskLevel} · {item.durationDays} days</span><small>{currency(item.minimumAmount)} – {currency(item.maximumAmount)} · {item._count.requests} requests</small></div><div className="admin-opportunity-actions"><span className="status-pill">{item.status}</span><button type="button" className="icon-action" aria-label={`Edit ${item.title}`} onClick={()=>editOpportunity(item)}><Edit3 size={14}/></button><div>{statuses.filter(status=>status!==item.status).map(status=><button key={status} type="button" className="text-link" onClick={async()=>{setBusy(item.id);try{const response=await fetch('/api/admin/investments',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action:'update-opportunity',id:item.id,status})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to change opportunity status.');await load();}catch(exception){setError(exception instanceof Error?exception.message:'Unable to change status.');}finally{setBusy('');}}} disabled={busy===item.id}>{status==='AVAILABLE'?<Check size={13}/>:null}{status}</button>)}</div></div></article>)}</div>:<p className="account-empty">No investment opportunities configured.</p>}
   </section>
  </div>
  <section className="account-panel card p-5 mt-4"><div className="account-panel-title"><div><h2>Investment requests</h2><p className="account-panel-subtitle">DEMO payouts are virtual and manually set. REAL references are recorded only; this app does not verify external execution.</p></div></div>
   {data.requests.length?<div className="admin-investment-request-list">{data.requests.map(item=>{const itemControls=controls[item.id]||controlsFor(item);const actions=actionsFor(item.status);return <article key={item.id}><header><div><span className="account-kicker">{item.accountMode} · {item.opportunity.category}</span><h3>{item.opportunity.title}</h3><p>{item.user.name||item.user.email} · {currency(item.amount)} · {item.opportunity.riskLevel}</p></div><span className={`status-pill ${item.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{item.status.replaceAll('_',' ')}</span></header>
    <div className="admin-investment-controls"><label className="account-label">Admin note<input className="input" maxLength={500} value={itemControls.note} onChange={event=>updateControls(item.id,'note',event.target.value)}/></label>
     {actions.includes('activate')&&item.accountMode==='REAL'&&<label className="account-label">External execution reference (required)<input className="input" minLength={3} maxLength={180} value={itemControls.executionReference} onChange={event=>updateControls(item.id,'executionReference',event.target.value)}/></label>}
     {actions.includes('settle')&&item.accountMode==='REAL'&&<label className="account-label">External settlement reference (required)<input className="input" minLength={3} maxLength={180} value={itemControls.settlementReference} onChange={event=>updateControls(item.id,'settlementReference',event.target.value)}/></label>}
     {actions.includes('settle')&&item.accountMode==='DEMO'&&<label className="account-label">Simulated payout (USD)<input className="input" type="number" min="0" max="1000000000" step="0.01" value={itemControls.simulatedPayout} onChange={event=>updateControls(item.id,'simulatedPayout',event.target.value)}/></label>}
    </div>
    {actions.length>0&&<div className="admin-investment-buttons">{actions.map(action=>{const missingReference=action==='activate'&&item.accountMode==='REAL'&&itemControls.executionReference.trim().length<3;const missingSettlement=action==='settle'&&(item.accountMode==='REAL'?itemControls.settlementReference.trim().length<3:itemControls.simulatedPayout.trim()==='');return <button type="button" key={action} className={`btn ${action==='reject'||action==='cancel'?'bg-white/5':'bg-gold text-black'}`} disabled={!!busy||missingReference||missingSettlement} onClick={()=>void transition(item,action)}>{busy===`${item.id}:${action}`?'Saving…':action.replaceAll('_',' ')}</button>;})}</div>}
    <small className="muted">Request {item.id} · submitted {new Date(item.requestedAt).toLocaleString()}{item.externalExecutionReference?` · execution ref ${item.externalExecutionReference}`:''}{item.settlementReference?` · settlement ref ${item.settlementReference}`:''}</small>
   </article>;})}</div>:<p className="account-empty">No investment requests are awaiting or have completed review.</p>}
  </section>
 </div>;
}