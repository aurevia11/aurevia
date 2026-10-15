'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {RefreshCw,Search,Trash2} from 'lucide-react';

type AdminUser={id:string;email:string;name:string|null;phone:string|null;country:string|null;role:'USER'|'ADMIN';status:string;accountMode:string;kycStatus:string;createdAt:string;depositEnabled:boolean;withdrawalEnabled:boolean;accountRestricted:boolean;restrictionReason:string|null};

export default function AdminUsersPanel(){
	const [users,setUsers]=useState<AdminUser[]>([]);
	const [search,setSearch]=useState('');
	const [selected,setSelected]=useState<AdminUser|null>(null);
	const [confirmation,setConfirmation]=useState('');
	const [reason,setReason]=useState('');
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);
	const [busyUserId,setBusyUserId]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	const load=useCallback(async(query:string,signal?:AbortSignal)=>{
		try{
			const response=await fetch(`/api/admin/users${query?`?search=${encodeURIComponent(query)}`:''}`,{cache:'no-store',signal});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load user accounts.');
			setUsers(result);setError('');
		}catch(exception){if(!(exception instanceof DOMException&&exception.name==='AbortError'))setError(exception instanceof Error?exception.message:'Unable to load user accounts.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{
		const controller=new AbortController();
		const timer=window.setTimeout(()=>void load(search.trim(),controller.signal),200);
		return()=>{window.clearTimeout(timer);controller.abort()};
	},[load,search]);

	async function deleteAccount(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!selected||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selected.id,confirmation,reason})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Account deletion could not be completed.');
			setNotice(`Account ${selected.id} was anonymized and closed.`);setSelected(null);setConfirmation('');setReason('');await load(search.trim());
		}catch(exception){setError(exception instanceof Error?exception.message:'Account deletion could not be completed.')}
		finally{setBusy(false)}
	}

	async function toggleStatus(user:AdminUser){
		if(busy)return;
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const status=user.status==='ACTIVE'?'FROZEN':'ACTIVE';
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,status})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update account status.');
			setNotice(`Account status updated to ${status.toLowerCase()}.`);await load(search.trim());
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account status.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	return <div className="account-page admin-users-page">
		<header className="account-heading"><div><span className="account-kicker">WORKSPACE · ACCOUNTS</span><h1>User accounts</h1><p>Search account status and manage closures with an auditable confirmation.</p></div><button className="icon-action" type="button" aria-label="Refresh user accounts" onClick={()=>void load(search.trim())}><RefreshCw size={15}/></button></header>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}
		<label className="account-label mb-4 block">Search users by name, email, or account ID<div className="relative mt-1"><Search size={15} className="absolute left-3 top-3.5 muted"/><input className="input pl-9" value={search} onChange={event=>setSearch(event.target.value)} maxLength={120} autoComplete="off" placeholder="Search accounts"/></div></label>
		<div className="overflow-hidden rounded-md border border-white/10">
			{loading?<p className="account-empty" role="status">Loading accounts…</p>:users.length?<div className="divide-y divide-white/10">{users.map(user=><article className="p-4" key={user.id}>
				<div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><b className="block break-words">{user.name||'Unnamed account'} · {user.email}</b><small className="muted break-all">{user.id} · {user.role} · {user.accountMode} · {user.kycStatus} · {user.status}</small></div><div className="flex flex-wrap gap-2"><button type="button" className="btn min-h-10 bg-white/5" disabled={busy||user.status==='CLOSED'} onClick={()=>void toggleStatus(user)}>{busyUserId===user.id?'Saving…':user.status==='ACTIVE'?'Suspend':'Reactivate'}</button><button type="button" className="btn min-h-10 bg-loss text-black" disabled={user.status==='CLOSED'} onClick={()=>{setSelected(user);setConfirmation('');setReason('')}}><Trash2 size={14}/>{user.status==='CLOSED'?'Closed':'Delete account'}</button></div></div>
				<details className="mt-2"><summary className="min-h-10 cursor-pointer py-2 text-sm gold">Profile and account controls</summary><dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="muted">Country</dt><dd>{user.country||'Not set'}</dd></div><div><dt className="muted">Phone</dt><dd>{user.phone||'Not set'}</dd></div><div><dt className="muted">Created</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd></div><div><dt className="muted">Deposit / withdrawal</dt><dd>{user.depositEnabled?'Enabled':'Disabled'} / {user.withdrawalEnabled?'Enabled':'Disabled'}</dd></div><div><dt className="muted">Account restriction</dt><dd>{user.accountRestricted?user.restrictionReason||'Restricted':'None'}</dd></div></dl></details>
			</article>)}</div>:<p className="account-empty">No accounts match this search.</p>}
		</div>
		{selected&&<section className="account-panel mt-4 border border-loss/30 p-5" aria-labelledby="confirm-delete-heading"><h2 id="confirm-delete-heading" className="font-semibold">Confirm account deletion</h2><p className="mt-2 text-sm muted">This anonymizes personal data and revokes access while preserving ledger and transaction records. Target: {selected.name||selected.email} ({selected.id}). Deleting the last active administrator is blocked.</p>
			<form className="mt-4 grid max-w-2xl gap-3" onSubmit={event=>void deleteAccount(event)}>
				<label className="account-label">Reason for audit history<input className="input" required minLength={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label>
				<label className="account-label">Type DELETE to confirm<input className="input" required autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>
				<div className="flex flex-wrap gap-2"><button className="btn bg-loss text-black" type="submit" disabled={busy||confirmation!=='DELETE'||reason.trim().length<3} aria-busy={busy}>{busy?'Deleting…':'Confirm deletion'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setSelected(null)}>Cancel</button></div>
			</form>
		</section>}
	</div>;
}