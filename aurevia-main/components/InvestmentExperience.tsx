'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {ArrowUpRight,RefreshCw,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';
import {useLocale} from '@/lib/i18n-context';

type Opportunity={id:string;title:string;category:string;description:string;assetSymbol:string|null;minimumAmount:string;maximumAmount:string|null;targetReturnPercent:string|null;durationDays:number;startsAt:string|null;maturesAt:string|null;riskLevel:string;status:string;demoEligible:boolean;realEligible:boolean;requiresApproval:boolean;targetPrice:string|null;stopPrice:string|null};
type Request={id:string;opportunityId:string;accountMode:'DEMO'|'REAL';amount:string;status:string;requestedAt:string;activatedAt:string|null;maturesAt:string|null;settlementReference:string|null;simulatedPayout:string|null;opportunity:{title:string;category:string;riskLevel:string;targetReturnPercent:string|null;durationDays:number}};
type Payload={accountMode:'DEMO'|'REAL';availableBalance:string;opportunities:Opportunity[];requests:Request[]};

function amount(value:string|number|null|undefined,notSet:string){return value===null||value===undefined?notSet:`$${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
function statusText(value:string){return value.replaceAll('_',' ');}
function dateText(value:string|null,notSet:string){return value?new Date(value).toLocaleDateString():notSet;}

export default function InvestmentExperience(){
 const {translate}=useLocale();
 const [data,setData]=useState<Payload|null>(null);
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');

 const load=useCallback(async(showLoading=false)=>{
  if(showLoading)setLoading(true);
  try{
   const response=await fetch('/api/investments',{cache:'no-store'});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||translate('unableToLoadInvestments'));
   setData(result);setError('');
  }catch(exception){setError(exception instanceof Error?exception.message:translate('unableToLoadInvestments'));}
  finally{if(showLoading)setLoading(false);}
 },[translate]);

 useEffect(()=>{void load(true);},[load]);

 async function submit(event:FormEvent<HTMLFormElement>,opportunity:Opportunity){
  event.preventDefault();if(busy)return;
  const value=Number(amounts[opportunity.id]);
  if(!Number.isFinite(value)||value<=0){setError(translate('validInvestmentAmount'));return;}
  setBusy(opportunity.id);setError('');setNotice('');
  try{
   const response=await fetch('/api/investments',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({opportunityId:opportunity.id,amount:value})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||translate('unableToSubmitInvestment'));
   setNotice(data?.accountMode==='DEMO'?translate('demoRequestRecorded'):translate('realRequestRecorded'));
   setAmounts(current=>({...current,[opportunity.id]:''}));
   await load();
  }catch(exception){setError(exception instanceof Error?exception.message:translate('unableToSubmitInvestment'));}
  finally{setBusy('');}
 }

 return <><Nav/><main className="account-page">
  <header className="account-heading"><div><span className="account-kicker">{translate('investmentsKicker')}</span><h1>{translate('investmentsTitle')}</h1><p>{translate('investmentSubtitle')}</p></div><span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?translate('portfolioAccount',{mode:data.accountMode}):translate('investmentLoadingAccount')}</span></header>
  {data?.accountMode==='DEMO'?<div className="account-callout mb-4"><span>Simulated only. DEMO requests reserve virtual USD and any payout entered by an administrator is not a real investment result.</span></div>:data?.accountMode==='REAL'?<div className="account-callout mb-4"><span>REAL requests require administrator review of an identity profile, not external KYC/AML clearance. No investment provider is connected, so REAL requests cannot be activated, completed, or settled and no REAL funds are moved.</span></div>:null}
  {notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<div className="account-callout mb-3" role="alert"><span>{error}</span><button type="button" className="text-link" onClick={()=>void load(true)}><RefreshCw size={14}/> Retry</button></div>}
  <section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('availableOpportunities')}</h2><p className="account-panel-subtitle">{translate('targetFigures')}</p></div>{data&&<span className="muted text-sm">{translate('availableCashLabel')} {amount(data.availableBalance,translate('investmentNotSet'))}</span>}</div>
   {loading&&!data?<p className="account-empty" role="status">{translate('loadingOpportunities')}</p>:data?.opportunities.length?<div className="mt-4 grid gap-4 lg:grid-cols-2">{data.opportunities.map(opportunity=>{
    const value=Number(amounts[opportunity.id]||0);const target=opportunity.targetReturnPercent===null?null:value*(1+Number(opportunity.targetReturnPercent)/100);
    return <article className="investment-opportunity" key={opportunity.id}>
     <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="account-kicker">{opportunity.category}{opportunity.assetSymbol?` · ${opportunity.assetSymbol}`:''}</span><h3>{opportunity.title}</h3></div><span className="status-pill">{opportunity.riskLevel.replaceAll('_',' ')}</span></div>
     <p className="investment-description">{opportunity.description}</p>
     <dl className="investment-terms"><div><dt>{translate('minimum')}</dt><dd>{amount(opportunity.minimumAmount,translate('investmentNotSet'))}</dd></div><div><dt>{translate('maximum')}</dt><dd>{amount(opportunity.maximumAmount,translate('investmentNotSet'))}</dd></div><div><dt>{translate('duration')}</dt><dd>{translate('durationDays',{days:opportunity.durationDays})}</dd></div><div><dt>{translate('start')}</dt><dd>{dateText(opportunity.startsAt,translate('setOnActivation'))}</dd></div><div><dt>{translate('maturity')}</dt><dd>{dateText(opportunity.maturesAt,translate('setOnActivation'))}</dd></div><div><dt>{translate('targetReturn')}</dt><dd>{opportunity.targetReturnPercent===null?translate('notSpecified'):translate('targetPercent',{percent:Number(opportunity.targetReturnPercent).toFixed(2)})}</dd></div></dl>
     {(opportunity.targetPrice||opportunity.stopPrice)&&<p className="investment-levels">{translate('referenceLevels')}: {translate('targetReturn')} {amount(opportunity.targetPrice,translate('investmentNotSet'))} · {translate('stopPrice')} {amount(opportunity.stopPrice,translate('investmentNotSet'))}</p>}
     <form className="investment-request-form" onSubmit={event=>void submit(event,opportunity)}><label className="account-label">{translate('amountUsd')}<input className="input" inputMode="decimal" type="number" min={Number(opportunity.minimumAmount)} max={opportunity.maximumAmount?Number(opportunity.maximumAmount):undefined} step="0.01" required value={amounts[opportunity.id]||''} onChange={event=>setAmounts(current=>({...current,[opportunity.id]:event.target.value}))}/></label><div className="investment-projection"><span>{translate('illustrativeTarget')}</span><b>{target===null?translate('unavailableTarget'):amount(target,translate('unavailableTarget'))}</b><small>{translate('projectionOnly')}</small></div><button className="btn bg-gold text-black" disabled={busy===opportunity.id}>{busy===opportunity.id?translate('submitting'):translate('requestInvestment')} <ArrowUpRight size={15}/></button></form>
     {data?.accountMode==='REAL'&&<p className="investment-disclosure"><ShieldCheck size={14}/> {translate('investmentSubmissionNotice')}</p>}
    </article>;
   })}</div>:<p className="account-empty">{translate('noOpportunities')}</p>}
  </section>
  <section className="account-panel card p-5 mt-4"><div className="account-panel-title"><div><h2>{translate('investmentActivity')}</h2><p className="account-panel-subtitle">{translate('privateToAccountMode')}</p></div><button type="button" className="text-link" onClick={()=>void load(true)}><RefreshCw size={14}/> {translate('investmentRefresh')}</button></div>
   {data?.requests.length?<div className="investment-request-list">{data.requests.map(item=><article className="investment-request-row" key={item.id}><div><b>{item.opportunity.title}</b><span>{item.opportunity.category} · {amount(item.amount,translate('investmentNotSet'))} · {item.accountMode}</span><small>{translate('investmentRequestStatus',{date:new Date(item.requestedAt).toLocaleString(),maturity:item.maturesAt?translate('maturityStatus',{date:new Date(item.maturesAt).toLocaleDateString()}):''})}</small>{item.settlementReference&&<small>{translate('referenceRecorded',{reference:item.settlementReference})}{item.accountMode==='REAL'?translate('notIndependentlyVerified'):''}</small>}</div><span className={`status-pill ${item.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{statusText(item.status)}</span></article>)}</div>:<p className="account-empty">{translate('noInvestmentRequests')}</p>}
  </section>
 </main></>;
}