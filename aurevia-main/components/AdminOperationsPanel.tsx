'use client';

import {useEffect,useState} from 'react';
import {ArrowDownLeft,ArrowUpRight,RefreshCw} from 'lucide-react';

type Order={id:string;user:{email:string;name:string|null};instrument:{symbol:string};side:string;type:string;status:string;accountMode:string;quantity:string|number;price:string|number|null;createdAt:string;providerName:string|null;providerOrderId:string|null;providerStatus:string|null;reconciliationStatus:string|null;reconciledAt:string|null;executions:Array<{quantity:string|number;price:string|number;fee:string|number;createdAt:string;providerExecutionId?:string|null}>};
type LedgerEntry={id:string;type:string;amount:string|number;account:{code:string;name:string;currency:string;accountMode:string;user:{email:string}|null}};
type LedgerTransaction={id:string;reference:string;description:string;createdAt:string;entries:LedgerEntry[]};

export default function AdminOperationsPanel(){
	const [orders,setOrders]=useState<Order[]>([]);
	const [ledger,setLedger]=useState<LedgerTransaction[]>([]);
	const [tab,setTab]=useState<'orders'|'ledger'>('orders');
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');

	async function load(){
		setLoading(true);
		try{
			const response=await fetch('/api/admin/operations',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load operations history.');
			setOrders(result.orders);setLedger(result.ledgerTransactions);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load operations history.');}
		finally{setLoading(false);}
	}

	useEffect(()=>{void load()},[]);

	return <section id="operations" className="card p-4 sm:p-5">
		<header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">Orders and transactions / ledger</h2><p className="mt-1 text-sm muted">Recent persisted records; balances are derived from double-entry ledger entries.</p></div><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>Refresh</button></header>
		<div className="mt-3 flex gap-2" role="tablist" aria-label="Operations history"><button type="button" role="tab" aria-selected={tab==='orders'} className={`btn min-h-11 ${tab==='orders'?'bg-gold text-black':'bg-white/5'}`} onClick={()=>setTab('orders')}>Orders</button><button type="button" role="tab" aria-selected={tab==='ledger'} className={`btn min-h-11 ${tab==='ledger'?'bg-gold text-black':'bg-white/5'}`} onClick={()=>setTab('ledger')}>Ledger</button></div>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{loading&&!orders.length&&!ledger.length?<p className="mt-4 muted">Loading recent records…</p>:tab==='orders'?orders.length?<div className="mt-3 divide-y divide-white/10">{orders.map(order=><article className="py-3" key={order.id}><div className="flex flex-wrap justify-between gap-2"><b>{order.instrument.symbol} · {order.side} {order.type}</b><span className="status-pill">{order.status.replaceAll('_',' ')}</span></div><p className="mt-1 break-all text-sm muted">{order.user.name||order.user.email} · {order.accountMode} · {Number(order.quantity).toLocaleString()} units · {order.price===null?'Market':Number(order.price).toLocaleString()}</p><small className="muted">{order.id} · {new Date(order.createdAt).toLocaleString()} · {order.executions.length} executions</small>{order.accountMode==='REAL'&&<><p className="mt-1 break-all text-xs muted">Provider: {order.providerName||'None'} · Order ID: {order.providerOrderId||'Not submitted'} · Provider status: {order.providerStatus||'N/A'} · Reconciliation: {order.reconciliationStatus||'Not reconciled'}{order.reconciledAt?` · ${new Date(order.reconciledAt).toLocaleString()}`:''}</p>{order.executions.some(execution=>execution.providerExecutionId)&&<p className="mt-1 break-all text-xs muted">Provider executions: {order.executions.map(execution=>execution.providerExecutionId).filter(Boolean).join(', ')}</p>}</>}</article>)}</div>:<p className="mt-4 muted">No orders recorded.</p>:ledger.length?<div className="mt-3 divide-y divide-white/10">{ledger.map(transaction=><article className="py-3" key={transaction.id}><div className="flex flex-wrap justify-between gap-2"><b className="break-all">{transaction.reference}</b><time className="muted text-xs">{new Date(transaction.createdAt).toLocaleString()}</time></div><p className="mt-1 text-sm">{transaction.description}</p><div className="mt-2 grid gap-1 sm:grid-cols-2">{transaction.entries.map(entry=>{const Icon=entry.type==='DEBIT'?ArrowUpRight:ArrowDownLeft;return <p className="flex min-w-0 items-center gap-2 break-all text-xs muted" key={entry.id}><Icon size={14}/>{entry.type} · {entry.account.user?.email||entry.account.code} · {Number(entry.amount).toLocaleString()} {entry.account.currency}</p>})}</div></article>)}</div>:<p className="mt-4 muted">No ledger transactions recorded.</p>}
	</section>;
}