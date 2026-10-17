'use client';

import {FormEvent,useEffect,useState} from 'react';
import {RefreshCw,Save} from 'lucide-react';
import {SIMULATED_BTC_ADDRESS_SETTING} from '@/lib/config/simulated-bitcoin-address';

type Setting={key:string;value:string;updatedAt:string};

export default function AdminSettingsPanel(){
	const [settings,setSettings]=useState<Setting[]>([]);
	const [newKey,setNewKey]=useState('');
	const [newValue,setNewValue]=useState('');
	const [loading,setLoading]=useState(true);
	const [busyKey,setBusyKey]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	async function load(){
		setLoading(true);setError('');
		try{
			const response=await fetch('/api/admin/settings',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load system settings.');
			setSettings(result);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load system settings.')}
		finally{setLoading(false)}
	}

	useEffect(()=>{void load()},[]);

	async function save(key:string,value:string):Promise<boolean>{
		if(busyKey)return false;
		setBusyKey(key);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save this setting.');
			setSettings(current=>[...current.filter(setting=>setting.key!==key),result].sort((a,b)=>a.key.localeCompare(b.key)));
			setNotice(`${key} saved.`);
			return true;
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save this setting.')}
		finally{setBusyKey('')}
		return false;
	}

	async function createSetting(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		const key=newKey.trim();
		if(!key||busyKey)return;
		if(await save(key,newValue)){setNewKey('');setNewValue('')}
	}

	return <div className="account-page">
		<header className="account-heading"><div><span className="account-kicker">SERVICE &amp; SYSTEM</span><h1>System settings</h1><p>Manage the system values consumed by the application.</p></div><button className="icon-action" type="button" aria-label="Refresh system settings" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/></button></header>
		<div className="account-callout mb-4"><span>Bitcoin address configuration is for display only. Deposits remain simulated; the application does not monitor or process Bitcoin transfers.</span></div>
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Configured values</h2><p className="account-panel-subtitle">Saving a value records an administrator audit event.</p></div></div>
			{loading?<p className="account-empty" role="status">Loading system settings…</p>:<div className="mt-4 space-y-4">{settings.map(setting=><SettingEditor key={setting.key} setting={setting} busy={busyKey===setting.key} onSave={save}/>)}</div>}
			{!loading&&!settings.some(setting=>setting.key===SIMULATED_BTC_ADDRESS_SETTING)&&<SettingEditor setting={{key:SIMULATED_BTC_ADDRESS_SETTING,value:'',updatedAt:''}} busy={busyKey===SIMULATED_BTC_ADDRESS_SETTING} onSave={save}/>}
			{!loading&&<form className="mt-5 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]" onSubmit={event=>void createSetting(event)}>
				<label className="account-label">Setting key<input className="input mt-1" required minLength={1} maxLength={100} value={newKey} onChange={event=>setNewKey(event.target.value)}/></label>
				<label className="account-label">Value<input className="input mt-1" maxLength={500} value={newValue} onChange={event=>setNewValue(event.target.value)}/></label>
				<button className="btn min-h-11 bg-gold text-black sm:self-end" type="submit" disabled={Boolean(busyKey)}><Save size={15}/>{busyKey===newKey?'Saving…':'Add setting'}</button>
			</form>}
		</section>
	</div>;
}

function SettingEditor({setting,busy,onSave}:{setting:Setting;busy:boolean;onSave:(key:string,value:string)=>Promise<boolean>}){
	const [value,setValue]=useState(setting.value);
	useEffect(()=>setValue(setting.value),[setting.value]);
	const bitcoin=setting.key===SIMULATED_BTC_ADDRESS_SETTING;
	return <form className="grid gap-3 rounded-lg border border-white/10 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end" onSubmit={event=>{event.preventDefault();void onSave(setting.key,value)}}>
		<div><label className="account-label">Setting key<input className="input mt-1" value={setting.key} readOnly/></label>{setting.updatedAt&&<small className="muted">Updated {new Date(setting.updatedAt).toLocaleString()}</small>}</div>
		<label className="account-label">{bitcoin?'Display address (optional)':'Value'}<input className="input mt-1" maxLength={500} value={value} onChange={event=>setValue(event.target.value)} placeholder={bitcoin?'No address configured':''}/></label>
		<button className="btn min-h-11 bg-white/5" type="submit" disabled={busy||value===setting.value}><Save size={15}/>{busy?'Saving…':'Save'}</button>
		{bitcoin&&<p className="sm:col-span-3 text-xs muted">The address and QR are not payment instructions. Do not send Bitcoin; these simulated deposits cannot verify or credit on-chain transfers.</p>}
	</form>;
}
