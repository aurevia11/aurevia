'use client';

import {FormEvent,useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,Check,Edit3,Plus,RefreshCw,Save,ToggleLeft,ToggleRight} from 'lucide-react';
import AdminNav from '@/components/AdminNav';

type Method={id:string;name:string;enabled:boolean;demoOnly:boolean;depositEnabled:boolean;withdrawalEnabled:boolean;requiresNetwork:boolean;currencies:string[];destination:string|null;instructions:string|null;minimumAmount:string|number;maximumAmount:string|number|null;processingNotes:string|null;displayOrder:number};
type Funding={id:string;user:{email:string;name?:string|null};type:string;accountMode:string;method:string;amount:string|number;currency:string;status:string;createdAt:string;destinationInfo?:string|null;transactionReference?:string|null;referenceInfo?:string|null;adminNote?:string|null;settlementReference?:string|null;settledAt?:string|null;hasReceipt?:boolean};
type FormState={name:string;enabled:boolean;demoOnly:boolean;depositEnabled:boolean;withdrawalEnabled:boolean;requiresNetwork:boolean;currencies:string;destination:string;instructions:string;minimumAmount:string;maximumAmount:string;processingNotes:string;displayOrder:string};

const emptyForm:FormState={name:'',enabled:true,demoOnly:false,depositEnabled:true,withdrawalEnabled:true,requiresNetwork:false,currencies:'USD',destination:'',instructions:'',minimumAmount:'0',maximumAmount:'',processingNotes:'',displayOrder:'0'};
const amount=(value:string|number,currency:string)=>`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;

export default function AdminPayments(){
	const [methods,setMethods]=useState<Method[]>([]);
	const [queue,setQueue]=useState<Funding[]>([]);
	const [simulatedWithdrawals,setSimulatedWithdrawals]=useState<Funding[]>([]);
	const [settlementQueue,setSettlementQueue]=useState<Funding[]>([]);
	const [history,setHistory]=useState<Funding[]>([]);
	const [form,setForm]=useState<FormState>(emptyForm);
	const [editing,setEditing]=useState('');
	const [notes,setNotes]=useState<Record<string,string>>({});
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);

	async function load(showLoading=true){
		if(showLoading)setLoading(true);
		try{
			const responses=await Promise.all([fetch('/api/admin/payment-methods',{cache:'no-store'}),fetch('/api/admin/funding',{cache:'no-store'}),fetch('/api/admin/funding?history=true',{cache:'no-store'}),fetch('/api/admin/funding?settlement=true',{cache:'no-store'}),fetch('/api/admin/funding?lifecycle=true',{cache:'no-store'})]);
			const results=await Promise.all(responses.map(response=>response.json()));
			if(responses.some(response=>!response.ok))throw new Error('Administrator authorization required.');
			setMethods(results[0]);setQueue(results[1]);setHistory(results[2]);setSettlementQueue(results[3]);setSimulatedWithdrawals(results[4]);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load payment administration.')}
		finally{if(showLoading)setLoading(false)}
	}
	useEffect(()=>{void load();const timer=window.setInterval(()=>void load(false),10000);return()=>window.clearInterval(timer)},[]);

	function edit(method:Method){
		setEditing(method.id);setForm({name:method.name,enabled:method.enabled,demoOnly:method.demoOnly,depositEnabled:method.depositEnabled,withdrawalEnabled:method.withdrawalEnabled,requiresNetwork:method.requiresNetwork,currencies:method.currencies.join(', '),destination:method.destination||'',instructions:method.instructions||'',minimumAmount:String(method.minimumAmount),maximumAmount:method.maximumAmount===null?'':String(method.maximumAmount),processingNotes:method.processingNotes||'',displayOrder:String(method.displayOrder)});
	}

	async function saveMethod(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');
		const body={...form,currencies:[...new Set(form.currencies.split(/[\s,]+/).filter(Boolean).map(value=>value.toUpperCase()))],destination:form.destination.trim()||null,instructions:form.instructions.trim()||null,minimumAmount:Number(form.minimumAmount),maximumAmount:form.maximumAmount?Number(form.maximumAmount):null,processingNotes:form.processingNotes.trim()||null,displayOrder:Number(form.displayOrder)};
		try{
			const response=await fetch('/api/admin/payment-methods',{method:editing?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editing?{id:editing,...body}:body)});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save payment method.');
			setForm(emptyForm);setEditing('');setMessage('Payment method saved.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save payment method.')}
		finally{setBusy(false)}
	}

	async function review(request:Funding,decision:'APPROVED'|'REJECTED'){
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/funding',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:request.id,decision,note:notes[request.id]||undefined})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to review request.');
			setMessage(`${request.type} ${decision.toLowerCase()}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to review request.')}
		finally{setBusy(false)}
	}

	async function settle(request:Funding){
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/funding/settle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:request.id,note:notes[request.id]||undefined})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to record settlement.');
			setMessage(`Withdrawal settlement recorded for ${request.user.email}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to record settlement.')}
		finally{setBusy(false)}
	}

	async function releaseLegacyReservation(request:Funding){
		const note=notes[request.id]?.trim();
		if(!note||note.length<3){setError('Enter an audit reason of at least 3 characters before releasing this reservation.');return;}
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/funding/lifecycle',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({id:request.id,action:'FAIL',note})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to release the legacy reservation.');
			setMessage(`Legacy DEMO withdrawal reservation released for ${request.user.email}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to release the legacy reservation.')}
		finally{setBusy(false)}
	}

	async function openReceipt(requestId:string){
		try{const response=await fetch(`/api/admin/funding/${encodeURIComponent(requestId)}/receipt`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt unavailable.');window.open(result.url,'_blank','noopener,noreferrer')}
		catch(exception){setError(exception instanceof Error?exception.message:'Receipt unavailable.')}
	}

	return <><AdminNav/><main className="account-page">
		<header className="account-heading"><div><span className="account-kicker">ADMINISTRATION · PAYMENT OPERATIONS</span><h1>Payment configuration</h1><p>Manage available methods and review submitted deposit and withdrawal requests.</p></div><div className="flex gap-2"><Link className="button-secondary" href="/admin"><ArrowLeft size={14}/> Admin home</Link><button className="icon-action" type="button" aria-label="Refresh payment administration" onClick={()=>void load()}><RefreshCw size={15}/></button></div></header>
		{message&&<p className="mb-3 text-sm text-profit" role="status">{message}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<div className="account-content-grid admin-payment-grid">
			<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{editing?'Edit payment method':'Add payment method'}</h2><p className="account-panel-subtitle">Destination details are returned only to signed-in users for enabled methods.</p></div>{editing?<Edit3 size={18} className="gold"/>:<Plus size={18} className="gold"/>}</div>
				<form onSubmit={saveMethod} className="account-form-grid">
					<label className="account-label">Method name<input className="input" required minLength={2} maxLength={80} value={form.name} onChange={event=>setForm({...form,name:event.target.value})} placeholder="Bitcoin, Bank transfer"/></label>
					<label className="account-label">Supported currencies<input className="input" required value={form.currencies} onChange={event=>setForm({...form,currencies:event.target.value})} placeholder="USD, BTC"/></label>
					<label className="account-label md:col-span-2">{form.currencies.toUpperCase().split(/[\s,]+/).includes('BTC')||/\bbitcoin\b|\bbtc\b/i.test(form.name)?'BTC receiving address':'Destination / account information'}<textarea className="input min-h-20" maxLength={500} value={form.destination} onChange={event=>setForm({...form,destination:event.target.value})} placeholder={form.currencies.toUpperCase().split(/[\s,]+/).includes('BTC')||/\bbitcoin\b|\bbtc\b/i.test(form.name)?'bc1…':'Enter the administrator-configured destination'}/></label>
					<label className="account-label md:col-span-2">Customer instructions<textarea className="input min-h-20" maxLength={2000} value={form.instructions} onChange={event=>setForm({...form,instructions:event.target.value})}/></label>
					<label className="account-label">Minimum amount<input className="input" type="number" min="0" step="any" required value={form.minimumAmount} onChange={event=>setForm({...form,minimumAmount:event.target.value})}/></label>
					<label className="account-label">Maximum amount<input className="input" type="number" min="0.00000001" step="any" value={form.maximumAmount} onChange={event=>setForm({...form,maximumAmount:event.target.value})} placeholder="No limit"/></label>
					<label className="account-label">Display order<input className="input" type="number" min="0" step="1" value={form.displayOrder} onChange={event=>setForm({...form,displayOrder:event.target.value})}/></label>
					<label className="account-label md:col-span-2">Internal processing notes<textarea className="input min-h-16" maxLength={1000} value={form.processingNotes} onChange={event=>setForm({...form,processingNotes:event.target.value})}/></label>
					<div className="admin-payment-toggles md:col-span-2"><label><input type="checkbox" checked={form.enabled} onChange={event=>setForm({...form,enabled:event.target.checked})}/> Enabled</label><label><input type="checkbox" checked={form.demoOnly} onChange={event=>setForm({...form,demoOnly:event.target.checked})}/> Demo-only · no real funds</label><label><input type="checkbox" checked={form.depositEnabled} onChange={event=>setForm({...form,depositEnabled:event.target.checked})}/> Deposits</label><label><input type="checkbox" checked={form.withdrawalEnabled} onChange={event=>setForm({...form,withdrawalEnabled:event.target.checked})}/> Withdrawals</label><label><input type="checkbox" checked={form.requiresNetwork} onChange={event=>setForm({...form,requiresNetwork:event.target.checked})}/> Require network</label></div>
					<div className="flex gap-2 md:col-span-2"><button className="btn bg-gold text-black" disabled={busy}><Save size={14} className="mr-1 inline"/>{busy?'Saving…':editing?'Save changes':'Create method'}</button>{editing&&<button className="btn bg-white/5" type="button" onClick={()=>{setEditing('');setForm(emptyForm)}}>Cancel</button>}</div>
				</form>
			</section>
				<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Configured methods</h2><p className="account-panel-subtitle">Disabled methods cannot be selected for new requests.</p></div><ToggleRight size={18} className="gold"/></div>{loading?<p className="account-empty">Loading methods…</p>:methods.length?<div className="space-y-3">{methods.map(method=><article className="admin-method" key={method.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><b>{method.name} {method.demoOnly&&<span className="mode-demo">· DEMO ONLY</span>}</b><small>{method.currencies.join(', ')} · min {amount(method.minimumAmount,method.currencies[0])}{method.maximumAmount!==null?` · max ${amount(method.maximumAmount,method.currencies[0])}`:''}</small></div><span className={`status-pill ${method.enabled?'mode-demo':''}`}>{method.enabled?'Enabled':'Disabled'}</span></div><p>{method.destination||'No destination configured'}</p><div className="flex flex-wrap gap-2 text-xs muted"><span>{method.depositEnabled?'Deposit on':'Deposit off'}</span><span>{method.withdrawalEnabled?'Withdraw on':'Withdraw off'}</span>{method.requiresNetwork&&<span>Network required</span>}</div><button type="button" className="text-link mt-3" onClick={()=>edit(method)}><Edit3 size={13}/> Edit method</button></article>)}</div>:<p className="account-empty">No payment methods configured.</p>}</section>
		</div>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Funding review queue</h2><p className="account-panel-subtitle">REAL requests update the internal simulated ledger only after administrator review. Deposit evidence is required only for a selected payment method. DEMO deposits and withdrawals cannot be approved.</p></div><span className="status-pill">{queue.length} pending</span></div>{queue.length?<div className="admin-funding-list">{queue.map(request=><article className="admin-funding-row" key={request.id}><div className="admin-funding-summary"><b>{request.type} · {request.accountMode}</b><span>{amount(request.amount,request.currency)} · {request.method}</span><small>{request.user.name||request.user.email} · {request.id} · {new Date(request.createdAt).toLocaleString()}</small>{request.type==='DEPOSIT'&&<small>{request.hasReceipt?'Payment screenshot attached':request.method.startsWith('Simulated REAL')?'Simulated ledger request; no payment evidence expected':'No payment evidence attached'}</small>}{request.accountMode==='DEMO'&&<small>DEMO deposits and withdrawals are unavailable.</small>}{request.accountMode==='REAL'&&<small>Simulated internal ledger request; no external funds move.</small>}{request.transactionReference&&<small>Reference: {request.transactionReference}</small>}{request.destinationInfo&&<small>Destination: {request.destinationInfo}</small>}{request.hasReceipt&&<button type="button" className="text-link" onClick={()=>void openReceipt(request.id)}>View private receipt</button>}</div><label className="account-label">Admin note<input className="input" value={notes[request.id]||''} maxLength={500} onChange={event=>setNotes({...notes,[request.id]:event.target.value})} placeholder="Optional review note"/></label><div className="flex gap-2"><button type="button" disabled={busy||request.accountMode==='DEMO'} className="btn bg-profit text-black" onClick={()=>void review(request,'APPROVED')}>{request.accountMode==='DEMO'?'DEMO funding unavailable':'Approve'}</button><button type="button" disabled={busy} className="btn bg-loss" onClick={()=>void review(request,'REJECTED')}>Reject</button></div></article>)}</div>:<p className="account-empty">No funding requests are waiting for review.</p>}</section>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>DEMO withdrawal execution</h2><p className="account-panel-subtitle">DEMO withdrawals cannot be approved or paid. Only a legacy approved or processing request can be marked failed to release its old reservation.</p></div><span className="status-pill mode-demo">{simulatedWithdrawals.length} historical</span></div>{simulatedWithdrawals.length?<div className="admin-funding-list">{simulatedWithdrawals.map(request=><article className="admin-funding-row" key={request.id}><div className="admin-funding-summary"><b>Unavailable · {request.status}</b><span>{amount(request.amount,request.currency)} · {request.method}</span><small>{request.user.name||request.user.email} · {request.user.email}</small><small className="break-all">{request.id} · {new Date(request.createdAt).toLocaleString()}</small></div>{(request.status==='APPROVED'||request.status==='PROCESSING')&&<><label className="account-label">Reservation release audit reason<input className="input min-h-11" value={notes[request.id]||''} maxLength={500} onChange={event=>setNotes(current=>({...current,[request.id]:event.target.value}))} placeholder="Why is this legacy reservation being released?"/></label><button type="button" disabled={busy||!notes[request.id]?.trim()} className="btn bg-loss" onClick={()=>void releaseLegacyReservation(request)}>Release legacy reservation</button></>}</article>)}</div>:<p className="account-empty">No historical DEMO withdrawals.</p>}</section>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Withdrawal settlement queue</h2><p className="account-panel-subtitle">Complete an approved simulated withdrawal in the internal ledger. No external settlement reference or payment is involved.</p></div><span className="status-pill">{settlementQueue.length} ready</span></div>{settlementQueue.length?<div className="admin-funding-list">{settlementQueue.map(request=><article className="admin-funding-row" key={request.id}><div className="admin-funding-summary"><b>Simulated REAL withdrawal · {amount(request.amount,request.currency)}</b><span>{request.user.name||request.user.email} · {request.method}</span><small className="break-all">{request.id} · approved {new Date(request.createdAt).toLocaleString()}</small><small>Completing this request debits the reserved amount from the internal account ledger and generates an internal audit reference.</small></div><label className="account-label">Admin note<input className="input min-h-11" value={notes[request.id]||''} maxLength={500} onChange={event=>setNotes(current=>({...current,[request.id]:event.target.value}))} placeholder="Optional audit note"/></label><button type="button" disabled={busy} className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" onClick={()=>void settle(request)}>Complete simulated withdrawal</button></article>)}</div>:<p className="account-empty">No approved withdrawals are waiting for settlement review.</p>}</section>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Recent transaction history</h2><p className="account-panel-subtitle">Latest recorded requests, including completed review outcomes.</p></div><Check size={18} className="gold"/></div>{history.length?<div className="account-table-wrap"><table className="account-table"><thead><tr><th>Request</th><th>Account</th><th>User</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead><tbody>{history.map(request=><tr key={request.id}><td className="font-mono">{request.id}</td><td>{request.accountMode}</td><td>{request.user.email}</td><td>{request.method}</td><td>{amount(request.amount,request.currency)}</td><td>{request.status.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>:<p className="account-empty">No transaction history.</p>}</section>
	</main></>;
}