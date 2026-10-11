'use client';

import {useCallback,useEffect,useState} from 'react';
import {ExternalLink,RefreshCw} from 'lucide-react';

type ReceiptRequest={id:string;type:string;status:string;accountMode:string;amount:string|number;currency:string;hasReceipt:boolean;createdAt:string;user:{email:string;name:string|null};paymentMethod:{name:string}|null};

export default function AdminReceiptReviewPanel(){
	const [requests,setRequests]=useState<ReceiptRequest[]>([]);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [opening,setOpening]=useState('');
	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const response=await fetch('/api/admin/funding?history=true',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load receipt queue.');
			setRequests((result as ReceiptRequest[]).filter(request=>request.hasReceipt));setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load receipt queue.')}
		finally{setLoading(false)}
	},[]);
	useEffect(()=>{void load()},[load]);
	async function open(requestId:string){
		setOpening(requestId);setError('');
		try{
			const response=await fetch(`/api/admin/funding/${encodeURIComponent(requestId)}/receipt`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt unavailable.');
			window.open(result.url,'_blank','noopener,noreferrer');
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt unavailable.')}
		finally{setOpening('')}
	}
	return <section className="card p-5"><header className="flex items-start justify-between gap-3"><div><h2 className="font-bold">Private payment receipts</h2><p className="mt-1 text-sm muted">Admin-only signed access · uploading evidence does not credit funds.</p></div><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading} aria-label="Refresh receipt queue"><RefreshCw size={15}/></button></header>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{loading?<p className="mt-4 muted" role="status">Loading receipt queue…</p>:requests.length?<div className="mt-3 divide-y divide-white/10">{requests.map(request=><article key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><b>{request.type} · {request.accountMode} · {Number(request.amount).toLocaleString()} {request.currency}</b><p className="break-all text-xs muted">{request.user.name||request.user.email} · {request.paymentMethod?.name||'Payment method'} · {request.status.replaceAll('_',' ')}</p><small className="break-all muted">{request.id}</small></div><button type="button" className="btn min-h-11 bg-white/5" disabled={opening===request.id} onClick={()=>void open(request.id)}>{opening===request.id?'Opening…':<>View secure receipt <ExternalLink size={14}/></>}</button></article>)}</div>:<p className="mt-4 text-sm muted">No uploaded receipts are awaiting review.</p>}
	</section>;
}