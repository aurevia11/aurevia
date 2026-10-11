'use client';

import Link from 'next/link';
import {useCallback,useEffect,useState} from 'react';
import {Activity,ArrowUpRight,Building2,CircleDollarSign,Clock3,Landmark,ReceiptText,RefreshCw,ShieldCheck,TrendingDown,TrendingUp,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import {activityCategoryLabel,type ActivityCategory,type ActivityRecord} from '@/lib/activity';

const categories:ActivityCategory[]=['all','trade','personal-trade','investment','deposit','withdrawal','order','position','account','security'];
const categoryIcons:Record<ActivityCategory,typeof Activity>={all:Activity,trade:TrendingUp,'personal-trade':Activity,investment:Building2,deposit:CircleDollarSign,withdrawal:WalletCards,order:ReceiptText,position:Landmark,account:ShieldCheck,security:ShieldCheck};
const categoryLabels:Record<ActivityCategory,string>={all:'All',trade:'Trades','personal-trade':'Personal trade',investment:'Investments',deposit:'Deposits',withdrawal:'Withdrawals',order:'Orders',position:'Positions',account:'Account',security:'Security'};

type ActivityResponse={data:{items:ActivityRecord[];total:number;hasMore:boolean};category:ActivityCategory;categoryLabel:string;accountMode:'DEMO'|'REAL'};

export default function AccountActivityExperience(){
  const [category,setCategory]=useState<ActivityCategory>('all');
  const [data,setData]=useState<ActivityResponse|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  const load=useCallback(async(showLoading=false)=>{
    if(showLoading)setLoading(true);
    try{const response=await fetch(`/api/activity?category=${category}&limit=30`,{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Unable to load account activity.');setData(body);setError('');}
    catch(exception){setError(exception instanceof Error?exception.message:'Unable to load account activity.');}
    finally{if(showLoading)setLoading(false);}
  },[category]);

  useEffect(()=>{void load(true)},[load]);

  function changeCategory(next:ActivityCategory){if(next!==category){setCategory(next);setError('');}}
  function toggleLoading(){if(!busy)void load(true)}

  return <><Nav/><main className="account-page activity-page">
    <header className="account-heading"><div><span className="account-kicker">AUDITABLE ACTIVITY</span><h1>Account activity</h1><p>Orders, trades, investments, funding, positions, and account events from persisted records.</p></div><button className="icon-action" type="button" aria-label="Refresh account activity" onClick={toggleLoading} disabled={busy}><RefreshCw size={15} className={busy?'animate-spin':''}/></button></header>
    {data?.accountMode==='REAL'&&<div className="account-callout mb-4"><span>REAL execution and valuation are not connected. This feed contains recorded REAL requests and ledger activity only; it does not manufacture broker confirmations.</span></div>}
    {error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" onClick={()=>void load(true)}>Retry</button></div>}
    <section className="account-panel card p-4"><div className="activity-filter" role="group" aria-label="Activity categories">{categories.map(item=>{const Icon=categoryIcons[item];return <button key={item} type="button" aria-pressed={category===item} className={category===item?'is-active':''} onClick={()=>changeCategory(item)}><Icon size={14} aria-hidden="true"/><span>{categoryLabels[item]}</span></button>})}</div></section>
    <section className="account-panel card mt-4 overflow-hidden">
      <div className="account-panel-title px-4 pt-4"><div><h2>{data?.categoryLabel||activityCategoryLabel(category)}</h2><p className="account-panel-subtitle">{data?`${data.data.total} recorded entries`:'Loading persisted activity'}</p></div><span className="status-pill mode-demo">{data?.accountMode||'ACCOUNT'}</span></div>
      {loading&&!data?<div className="account-empty" role="status">Loading account activity…</div>:data?.data.items.length?<div className="activity-feed">{data.data.items.map(item=><ActivityRow key={item.id} item={item}/>)}</div>:<div className="account-empty"><Activity size={22} className="mx-auto mb-3 gold"/><p>No activity matches this filter.</p><small>New activity appears only after a persisted account event is recorded.</small></div>}
      {data&&data.data.hasMore&&<div className="activity-pagination"><span>Showing {data.data.items.length} of {data.data.total} entries</span><button type="button" className="button-secondary" onClick={()=>void load(true)}>Load more <ArrowUpRight size={13}/></button></div>}
    </section>
  </main></>;
}

function ActivityRow({item}:{item:ActivityRecord}){
  const Icon=activityIcon(item.category);
  const positive=item.pnl!==null&&Number(item.pnl)>=0;
  return <article className="activity-feed-row"><span className={`activity-icon activity-${item.category}`}><Icon size={16} aria-hidden="true"/></span><div className="activity-feed-main"><div><b>{item.action}</b><span>{item.asset}</span>{item.side&&<em>{item.side}</em>}{item.adminInitiated&&<small>ADMIN-INITIATED</small>}</div><p>{item.sourceLabel} · {statusLabel(item.status)}</p><details><summary>Details</summary><dl><Detail label="Amount" value={item.amount}/><Detail label="Quantity" value={item.quantity}/><Detail label="Price" value={item.price||'—'}/><Detail label="Status" value={item.status}/><Detail label="Source" value={item.sourceLabel}/>{item.pnl!==null&&<Detail label="P/L" value={item.pnl}/>}</dl></details></div><div className="activity-feed-meta"><time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time><b className={positive?'text-profit':item.pnl===null?'':'text-loss'}>{item.pnl===null?'':`${positive?'+':'−'}${item.pnl}`}</b><Link href={item.link} aria-label={`Open ${item.action} details`}><ArrowUpRight size={14}/></Link></div></article>;
}

function Detail({label,value}:{label:string;value:string}){return <div><dt>{label}</dt><dd>{value}</dd></div>}
function activityIcon(category:ActivityRecord['category']){return ({trade:TrendingUp,'personal-trade':Activity,investment:Building2,deposit:CircleDollarSign,withdrawal:WalletCards,order:ReceiptText,position:Landmark,account:ShieldCheck,security:ShieldCheck} as const)[category]||Activity}
function statusLabel(value:string){return value.replaceAll('_',' ').toLowerCase()}
function formatTime(value:string){return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value))}
