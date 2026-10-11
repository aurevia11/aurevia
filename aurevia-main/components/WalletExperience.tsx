'use client';

import {FormEvent,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {ArrowDownLeft,ArrowUpRight,Check,Copy,Eye,EyeOff,RefreshCw,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import {useLocale} from '@/lib/i18n-context';

type PaymentMethod={id:string;name:string;currencies:string[];destination:string|null;instructions:string|null;minimumAmount:string|number;maximumAmount:string|number|null;depositEnabled:boolean;withdrawalEnabled:boolean;requiresNetwork:boolean;demoOnly:boolean};
type FundingRecord={id:string;type:'DEPOSIT'|'WITHDRAWAL';method:string;amount:number|string;currency:string;status:string;accountMode:'DEMO'|'REAL';createdAt:string;transactionReference?:string|null;adminNote?:string|null;hasReceipt?:boolean};
type WalletData={accountMode:'DEMO'|'REAL';balance:number|string|null;balances:Array<{currency:string;balance:number|string}>;transactions:FundingRecord[]};
type PaymentMethodsResponse={methods:PaymentMethod[];fundingStatus:'DEMO'|'AVAILABLE'|'NOT_CONFIGURED'|'DISABLED'|'ERROR';realFundingAvailable:boolean};
type KycData={kycStatus:string;documents:number;verificationProfileSubmitted:boolean;withdrawalEnabled:boolean;accountRestricted:boolean;restrictionReason:string|null};

const money=(amount:number,currency='USD')=>`${amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;
const statuses:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending review',PROCESSING:'Processing',APPROVED:'Approved',COMPLETED:'Completed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const reserves=['PENDING','PENDING_REVIEW','PROCESSING'];
const fundingUnavailableMessage=(status:PaymentMethodsResponse['fundingStatus'])=>{
	if(status==='NOT_CONFIGURED')return 'Funding is temporarily unavailable because the payment provider is not configured. No funds were changed.';
	if(status==='DISABLED')return 'Funding is temporarily unavailable because the configured provider workflow is disabled. No funds were changed.';
	if(status==='ERROR')return 'Funding is temporarily unavailable because provider health could not be confirmed. No funds were changed.';
	return 'Funding is temporarily unavailable until a verified payment workflow is available. No funds were changed.';
};

function isWalletData(value:unknown):value is WalletData{
	if(!value||typeof value!=='object')return false;
	const data=value as Partial<WalletData>;
	const validAmount=(amount:unknown)=>amount===null||(typeof amount==='number'&&Number.isFinite(amount))||(typeof amount==='string'&&amount.trim()!==''&&Number.isFinite(Number(amount)));
	return (data.accountMode==='DEMO'||data.accountMode==='REAL')&&validAmount(data.balance)&&Array.isArray(data.balances)&&data.balances.every(item=>!!item&&typeof item.currency==='string'&&validAmount(item.balance))&&Array.isArray(data.transactions)&&data.transactions.every(item=>!!item&&typeof item.id==='string'&&(item.type==='DEPOSIT'||item.type==='WITHDRAWAL')&&typeof item.status==='string'&&validAmount(item.amount));
}

function isPaymentMethodsResponse(value:unknown):value is PaymentMethodsResponse{
	if(!value||typeof value!=='object')return false;
	const data=value as Partial<PaymentMethodsResponse>;
	return Array.isArray(data.methods)&&data.methods.every(method=>!!method&&typeof method.id==='string'&&typeof method.name==='string'&&Array.isArray(method.currencies)&&method.currencies.every(currency=>typeof currency==='string')&&typeof method.depositEnabled==='boolean'&&typeof method.withdrawalEnabled==='boolean')&&['DEMO','AVAILABLE','NOT_CONFIGURED','DISABLED','ERROR'].includes(String(data.fundingStatus))&&typeof data.realFundingAvailable==='boolean';
}

export default function WalletExperience(){
	const {data:session,status:sessionStatus}=useSession();
	const {translate}=useLocale();
	const activeMode=session?.user?.accountMode;
	const [data,setData]=useState<WalletData>({accountMode:'DEMO',balance:0,balances:[],transactions:[]});
	const [methods,setMethods]=useState<PaymentMethod[]>([]);
	const [fundingStatus,setFundingStatus]=useState<PaymentMethodsResponse['fundingStatus']>('NOT_CONFIGURED');
	const [realFundingAvailable,setRealFundingAvailable]=useState(false);
	const [profile,setProfile]=useState<KycData|null>(null);
	const [methodLoadError,setMethodLoadError]=useState('');
	const [profileLoadError,setProfileLoadError]=useState('');
	const [type,setType]=useState<'DEPOSIT'|'WITHDRAWAL'>('DEPOSIT');
	const [methodId,setMethodId]=useState('');
	const [currency,setCurrency]=useState('USD');
	const [amount,setAmount]=useState('');
	const [transactionReference,setTransactionReference]=useState('');
	const [referenceInfo,setReferenceInfo]=useState('');
	const [senderInfo,setSenderInfo]=useState('');
	const [destinationInfo,setDestinationInfo]=useState('');
	const [beneficiaryInfo,setBeneficiaryInfo]=useState('');
	const [network,setNetwork]=useState('');
	const [note,setNote]=useState('');
	const [confirming,setConfirming]=useState(false);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);
	const [hasWalletData,setHasWalletData]=useState(false);
	const [balanceVisible,setBalanceVisible]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [copied,setCopied]=useState(false);
	const copiedTimer=useRef<number|null>(null);
	const [idempotencyKey,setIdempotencyKey]=useState('');
	const [keyFingerprint,setKeyFingerprint]=useState('');
	const [receiptFiles,setReceiptFiles]=useState<Record<string,File|undefined>>({});
	const [receiptBusy,setReceiptBusy]=useState('');

	const availableMethods=useMemo(()=>methods.filter(method=>type==='DEPOSIT'?method.depositEnabled:method.withdrawalEnabled),[methods,type]);
	const selectedMethod=availableMethods.find(method=>method.id===methodId);
	const supportedCurrencies=useMemo(()=>selectedMethod?.currencies||[],[selectedMethod]);
	const currentBalanceRecord=data.balances.find(item=>item.currency===currency);
	const currentBalance=currentBalanceRecord?Number(currentBalanceRecord.balance):null;
	const pendingWithdrawal=useMemo(()=>data.transactions.filter(item=>item.type==='WITHDRAWAL'&&item.currency===currency&&reserves.includes(item.status)).reduce((sum,item)=>sum+Number(item.amount),0),[data.transactions,currency]);
	const availableBalance=currentBalance===null?null:currentBalance-pendingWithdrawal;
	const realKycApproved=profile?.kycStatus==='APPROVED'&&profile.documents>0&&profile.verificationProfileSubmitted;
	const realWithdrawalBlocked=data.accountMode==='REAL'&&!!profile&&(!profile.withdrawalEnabled||profile.accountRestricted);

	const load=useCallback(async(showLoading=false)=>{
		if(showLoading)setLoading(true);
		setError('');
		const requests=await Promise.allSettled([
			fetch('/api/wallet',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/payment-methods',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/profile',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
		]);
		const [walletRequest,methodsRequest,profileRequest]=requests;
		if(walletRequest.status==='fulfilled'&&walletRequest.value.response.ok&&isWalletData(walletRequest.value.result)){
			setData(walletRequest.value.result);setHasWalletData(true);
		}else{
			const result=walletRequest.status==='fulfilled'?walletRequest.value.result as {error?:string}:null;
			setData(current=>({...current,balance:null,balances:[],transactions:[]}));
			setHasWalletData(false);
			setError(result?.error||'Wallet data is temporarily unavailable. Please try again.');
		}
		if(methodsRequest.status==='fulfilled'&&methodsRequest.value.response.ok&&isPaymentMethodsResponse(methodsRequest.value.result)){
			setMethods(methodsRequest.value.result.methods);
			setFundingStatus(methodsRequest.value.result.fundingStatus);
			setRealFundingAvailable(methodsRequest.value.result.realFundingAvailable);
			setMethodLoadError('');
		}else{
			const result=methodsRequest.status==='fulfilled'?methodsRequest.value.result as {error?:string}:null;
			setMethods([]);setFundingStatus('ERROR');setRealFundingAvailable(false);
			setMethodLoadError(result?.error||'Funding options are temporarily unavailable. No funds were changed.');
		}
		if(profileRequest.status==='fulfilled'&&profileRequest.value.response.ok&&profileRequest.value.result&&typeof profileRequest.value.result==='object'){
			setProfile(profileRequest.value.result);setProfileLoadError('');
		}else{
			setProfile(null);setProfileLoadError('Account verification status is temporarily unavailable.');
		}
		if(showLoading)setLoading(false);
	},[]);

	useEffect(()=>{
		if(sessionStatus!=='authenticated')return;
		setData({accountMode:activeMode||'DEMO',balance:0,balances:[],transactions:[]});
		setMethods([]);setMethodId('');setFundingStatus('NOT_CONFIGURED');setRealFundingAvailable(false);setProfile(null);setMethodLoadError('');setProfileLoadError('');setHasWalletData(false);
		void load(true);
	},[sessionStatus,activeMode,load]);
	useEffect(()=>{
		if(!availableMethods.some(method=>method.id===methodId))setMethodId(availableMethods[0]?.id||'');
	},[availableMethods,methodId]);
	useEffect(()=>{if(supportedCurrencies.length&&!supportedCurrencies.includes(currency))setCurrency(supportedCurrencies[0])},[supportedCurrencies,currency]);
	useEffect(()=>()=>{if(copiedTimer.current!==null)window.clearTimeout(copiedTimer.current)},[]);

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();	setConfirming(true);setMessage('');setError('');
	}

	async function confirmSubmit(){
		if(!selectedMethod||submitting)return;
		setSubmitting(true);setError('');
		const payload={type,paymentMethodId:selectedMethod.id,amount:Number(amount),currency,transactionReference:transactionReference||undefined,referenceInfo:referenceInfo||undefined,senderInfo:senderInfo||undefined,destinationInfo:destinationInfo||undefined,beneficiaryInfo:beneficiaryInfo||undefined,network:network||undefined,note:note||undefined};
		const fingerprint=JSON.stringify(payload);
		const key=idempotencyKey&&keyFingerprint===fingerprint?idempotencyKey:window.crypto.randomUUID();setIdempotencyKey(key);setKeyFingerprint(fingerprint);
		try{
			const response=await fetch('/api/wallet',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload)});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit this request.');
			setMessage(response.status===200?`Request ${result.id} already exists with status ${String(result.status).replaceAll('_',' ')}. No new request was created.`:`Request ${result.id} submitted for administrator review. The ledger has not been posted.`);
			setAmount('');setTransactionReference('');setReferenceInfo('');setSenderInfo('');setDestinationInfo('');setBeneficiaryInfo('');setNetwork('');setNote('');setIdempotencyKey('');setKeyFingerprint('');setConfirming(false);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit this request.');}
		finally{setSubmitting(false);}
	}

	async function copyDestination(){
		if(!selectedMethod?.destination||selectedMethod.demoOnly)return;
		try{await navigator.clipboard.writeText(selectedMethod.destination);setCopied(true);if(copiedTimer.current!==null)window.clearTimeout(copiedTimer.current);copiedTimer.current=window.setTimeout(()=>{setCopied(false);copiedTimer.current=null},1500)}catch{setError('Clipboard access is unavailable in this browser.')}
	}

	async function uploadReceipt(request:FundingRecord){
		const file=receiptFiles[request.id];if(!file||receiptBusy)return;
		setReceiptBusy(request.id);setError('');setMessage('');
		try{
			const body=new FormData();body.append('file',file);
			const response=await fetch(`/api/wallet/${encodeURIComponent(request.id)}/receipt`,{method:'POST',body});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt upload failed.');
			const delivery=result.emailDelivery==='sent'?'Support email sent.':result.emailDelivery==='failed'?'Support email failed; admin notification is recorded.':'Email is not configured; admin notification is recorded.';
			setMessage(`Receipt stored privately. Funds were not credited. ${delivery}`);setReceiptFiles(current=>({...current,[request.id]:undefined}));await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt upload failed.')}
		finally{setReceiptBusy('')}
	}

	async function openReceipt(requestId:string){
		try{
			const response=await fetch(`/api/wallet/${encodeURIComponent(requestId)}/receipt`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt unavailable.');
			window.open(result.url,'_blank','noopener,noreferrer');
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt unavailable.')}
	}

	return <><Nav/><main className="account-page">
		<header className="account-heading"><div><span className="account-kicker">{data.accountMode} ACCOUNT · {translate('walletHeader')}</span><h1>{translate('walletTitle')}</h1><p>{data.accountMode==='DEMO'?translate('walletSubtitle'):translate('realFundingNotice')}</p></div><span className={`status-pill ${data.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{data.accountMode} ACCOUNT</span></header>
		{data.accountMode==='REAL'&&!realKycApproved&&<div className="account-callout account-mode-notice"><span>{translate('verificationRequired')}</span><Link className="text-link" href="/kyc">{translate('openVerification')}</Link></div>}
		{realWithdrawalBlocked&&<div className="account-callout account-mode-notice"><span>{profile?.accountRestricted?translate('accountRestrictedNotice'):translate('withdrawalDisabled')}{profile?.restrictionReason?` ${profile.restrictionReason}`:''}</span><Link className="text-link" href="/support">{translate('contactSupportAction')}</Link></div>}
		{data.accountMode==='REAL'&&!realFundingAvailable&&<div className="account-callout account-mode-notice" role="status"><span>{fundingUnavailableMessage(fundingStatus)}</span></div>}
		{data.accountMode==='REAL'&&profileLoadError&&<div className="account-callout account-mode-notice" role="status"><span>{profileLoadError} REAL funding requests remain disabled until this status can be verified.</span></div>}
		<section className="wallet-balance-panel"><div className="wallet-balance-heading"><div className="account-kicker">{translate('availableBalances',{mode:data.accountMode.toLowerCase()})}</div><button type="button" className="wallet-balance-toggle" aria-label={balanceVisible?'Hide balances':'Show balances'} aria-pressed={!balanceVisible} onClick={()=>setBalanceVisible(value=>!value)}>{balanceVisible?<EyeOff size={16}/>:<Eye size={16}/>}<span>{balanceVisible?'Hide':'Show'}</span></button></div><div className="wallet-balance-value">{loading?translate('loading'):!hasWalletData||data.balance===null?'Unavailable':balanceVisible?money(Number(data.balance)): '••••••'}</div><p className="wallet-demo-note">{hasWalletData?translate('walletDemoNote'):'Balance could not be retrieved. No balance is assumed.'}</p><div className="wallet-currency-list">{data.balances.map(item=><span key={item.currency}>{balanceVisible?money(Number(item.balance),item.currency):`${item.currency} ••••••`}</span>)}</div></section>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		<div className="account-metrics mt-3"><div className="account-metric"><span>{translate('pendingReview')}</span><b>{hasWalletData?data.transactions.filter(item=>reserves.includes(item.status)).length:'—'}</b><small>{translate('noLedgerPosting')}</small></div><div className="account-metric"><span>{translate('withdrawalReservations')}</span><b>{hasWalletData?availableBalance===null?'Unavailable':money(pendingWithdrawal,currency):'—'}</b><small>{translate('requestsAwaitingReview',{currency})}</small></div><div className="account-metric"><span>{translate('enabledPaymentMethods')}</span><b>{methodLoadError?'—':methods.length}</b><small>{translate('configuredByAdministrator')}</small></div><div className="account-metric"><span>{translate('recentRequests')}</span><b>{hasWalletData?data.transactions.length:'—'}</b><small>{translate('latest100')}</small></div></div>
		<div className="account-content-grid">
			<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('fundingRequest')}</h2><p className="account-panel-subtitle">{translate('fundingRequestSubtitle')}</p></div><WalletCards size={18} className="gold" aria-hidden="true"/></div>
				<div className="wallet-type-switch" role="group" aria-label={translate('fundingRequestType')}><button type="button" aria-pressed={type==='DEPOSIT'} onClick={()=>{setType('DEPOSIT');setConfirming(false)}}><ArrowDownLeft size={15}/> {translate('deposit')}</button><button type="button" aria-pressed={type==='WITHDRAWAL'} onClick={()=>{setType('WITHDRAWAL');setConfirming(false)}}><ArrowUpRight size={15}/> {translate('withdrawal')}</button></div>
				<form onSubmit={submit} className="mt-4 space-y-4">
					<label className="account-label">{translate('paymentMethod')}<select className="input" required value={methodId} onChange={event=>setMethodId(event.target.value)}><option value="">{translate('selectEnabledMethod')}</option>{availableMethods.map(method=><option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
					{selectedMethod&&<>
						<label className="account-label">{translate('currency')}<select className="input" required value={currency} onChange={event=>setCurrency(event.target.value)}>{supportedCurrencies.map(item=><option key={item} value={item}>{item}</option>)}</select></label>
						<label className="account-label">{translate('amount',{currency})}<input className="input" type="number" min={selectedMethod.minimumAmount||'0.00000001'} max={selectedMethod.maximumAmount||undefined} step="any" inputMode="decimal" required value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0.00"/></label>
						{type==='DEPOSIT'?<>
							{(selectedMethod.destination||selectedMethod.instructions)&&<div className="account-callout deposit-instructions"><div><strong>{translate('administratorConfiguredPaymentInstructions')}</strong>{selectedMethod.destination&&<p className="mt-2 break-all font-mono text-xs">{selectedMethod.destination}</p>}{selectedMethod.instructions&&<p className="mt-2 text-sm">{selectedMethod.instructions}</p>}</div>{selectedMethod.destination&&<button type="button" className="icon-action" aria-label={translate('copyPaymentDestination')} onClick={()=>void copyDestination()}>{copied?<Check size={15}/>:<Copy size={15}/>}</button>}</div>}
							<label className="account-label">{translate('externalReference')}<input className="input" maxLength={180} value={transactionReference} onChange={event=>setTransactionReference(event.target.value)} placeholder={translate('paymentProviderReference')}/></label>
							<label className="account-label">{translate('senderReference')}<input className="input" maxLength={500} value={referenceInfo} onChange={event=>setReferenceInfo(event.target.value)} placeholder={translate('providerReference')}/></label>
							<label className="account-label">{translate('senderInformation')}<input className="input" maxLength={300} value={senderInfo} onChange={event=>setSenderInfo(event.target.value)} placeholder={translate('nameOrAccountDetails')}/></label>
							<div className="account-callout"><span>{translate('paymentProofUnavailable')}</span></div>
						</>:<>
							{selectedMethod.demoOnly?<div className="account-callout"><span>{translate('demoWithdrawalNotice')}</span></div>:<label className="account-label">{translate('destinationAddress')}<input className="input" required maxLength={500} value={destinationInfo} onChange={event=>setDestinationInfo(event.target.value)} placeholder={translate('payoutDestinationPlaceholder')}/></label>}
							{selectedMethod.requiresNetwork&&!selectedMethod.demoOnly&&<label className="account-label">{translate('network')}<input className="input" required maxLength={80} value={network} onChange={event=>setNetwork(event.target.value)} placeholder={translate('destinationNetworkPlaceholder')}/></label>}
							<label className="account-label">{translate('beneficiaryInformation')}<input className="input" maxLength={300} value={beneficiaryInfo} onChange={event=>setBeneficiaryInfo(event.target.value)} placeholder={translate('beneficiaryPlaceholder')}/></label>
							<div className="account-callout"><span>{translate('availableBalanceMessage',{currency})}: {availableBalance===null?'Unavailable':money(availableBalance,currency)}. {translate('fundsReservedMessage')}</span></div>
						</>}
						<label className="account-label">{translate('note')}<textarea className="input min-h-20" maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/></label>
					</>}
					{!availableMethods.length&&<div className="account-empty" role="status">{methodLoadError||translate('noDepositMethods',{type:type.toLowerCase()})}</div>}
					{confirming&&selectedMethod&&<div className="account-confirm-panel" role="alert"><h3>{translate('confirmRequest',{type:type.toLowerCase()})}</h3><p>{money(Number(amount||0),currency)} via {selectedMethod.name} in the {data.accountMode} account. This records a request only; it does not send or confirm payment.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn bg-gold text-black" disabled={submitting} onClick={()=>void confirmSubmit()}>{submitting?translate('submitRequestStatus'):translate('confirmRequestButton')}</button><button type="button" className="btn bg-white/5" onClick={()=>setConfirming(false)}>{translate('cancelRequestButton')}</button></div></div>}
					{!confirming&&<button className="btn w-full bg-gold text-black" type="submit" disabled={loading||!hasWalletData||!selectedMethod||(data.accountMode==='REAL'&&(!realFundingAvailable||!realKycApproved||!!profileLoadError))||(type==='WITHDRAWAL'&&(realWithdrawalBlocked||availableBalance===null))}>{type==='DEPOSIT'?translate('reviewDepositRequest'):translate('reviewWithdrawalRequest')}</button>}
				</form>
			</section>
			<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('transactionHistory')}</h2><p className="account-panel-subtitle">{translate('transactionHistorySubtitle')}</p></div><div className="flex items-center gap-2"><Link className="text-link" href="/wallet/transactions">{translate('fullHistory')}</Link><button type="button" className="icon-action" aria-label={translate('refreshWalletHistory')} onClick={()=>void load(true)}><RefreshCw size={15}/></button></div></div>
				{loading?<div className="account-empty" role="status">{translate('loadingWallet')}</div>:!hasWalletData?<div className="account-empty transaction-history-error" role="status">Transaction history is unavailable until wallet data can be loaded.</div>:data.transactions.length?<div className="account-table-wrap"><table className="account-table"><thead><tr><th>{translate('request')}</th><th>{translate('amount')}</th><th>{translate('status')}</th><th>{translate('receipt')}</th></tr></thead><tbody>{data.transactions.map(transaction=><tr key={transaction.id}><td><Link className="transaction-kind" href={`/wallet/transactions/${encodeURIComponent(transaction.id)}`}>{transaction.type==='DEPOSIT'?<ArrowDownLeft size={13}/>:<ArrowUpRight size={13}/>} {transaction.type}<small className="transaction-method">{transaction.method}</small><small className="transaction-method">{transaction.id}</small></Link></td><td>{money(Number(transaction.amount),transaction.currency)}</td><td><span className="status-pill">{statuses[transaction.status]||transaction.status}</span></td><td>{transaction.type==='DEPOSIT'&&reserves.includes(transaction.status)?<div className="grid min-w-40 gap-1"><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label={translate('chooseReceipt',{id:transaction.id})} onChange={event=>setReceiptFiles(current=>({...current,[transaction.id]:event.target.files?.[0]}))}/><button type="button" className="btn min-h-11 bg-white/5" disabled={!receiptFiles[transaction.id]||receiptBusy===transaction.id} onClick={()=>void uploadReceipt(transaction)}>{receiptBusy===transaction.id?translate('uploading'):translate('uploadReceipt')}</button>{transaction.hasReceipt&&<button type="button" className="text-link" onClick={()=>void openReceipt(transaction.id)}>{translate('viewPrivateReceipt')}</button>}</div>:transaction.hasReceipt?<button type="button" className="text-link" onClick={()=>void openReceipt(transaction.id)}>{translate('viewPrivateReceipt')}</button>:<span className="muted">—</span>}</td></tr>)}</tbody></table></div>:<div className="account-empty"><div><WalletCards size={22} className="mx-auto mb-3 gold"/><p>{translate('noFundingRequests')}</p></div></div>}
			</section>
		</div>
	</main></>;
}