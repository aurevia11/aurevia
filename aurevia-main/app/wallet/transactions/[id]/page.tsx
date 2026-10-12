'use client';

import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {ArrowLeft,Clock3,FileClock,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';

type Detail={transaction:Record<string,any>;history:Array<{action:string;createdAt:string;actor?:{name?:string|null;role:string}|null}>};

const labels:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending review',PROCESSING:'Processing',APPROVED:'Approved',COMPLETED:'Completed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const formatDate=(value?:string|null)=>value?new Date(value).toLocaleString():'Not recorded';
const formatAmount=(value:string|number,currency:string)=>`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;

export default function TransactionDetailPage(){
	const {id}=useParams<{id:string}>();
	const [data,setData]=useState<Detail|null>(null);
	const [error,setError]=useState('');
	useEffect(()=>{let active=true;fetch(`/api/funding/${encodeURIComponent(id)}`).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load transaction.');if(active)setData(result)}).catch(exception=>{if(active)setError(exception instanceof Error?exception.message:'Unable to load transaction.')});return()=>{active=false}},[id]);
	const transaction=data?.transaction;
	return <><Nav/><main className="account-page">
		<Link href="/wallet" className="text-link"><ArrowLeft size={15}/> Back to wallet</Link>
		{error?<section className="account-panel card mt-4 p-5"><p className="text-loss" role="alert">{error}</p></section>:!transaction?<section className="account-panel card mt-4 p-5" role="status">Loading transaction details…</section>:<>
			<header className="account-heading mt-5"><div><span className="account-kicker">{transaction.accountMode==='REAL'?'SIMULATED / CONFIGURED REAL':transaction.accountMode} ACCOUNT · Transaction detail</span><h1>{transaction.accountMode==='REAL'&&transaction.type==='DEPOSIT'?'Configured REAL deposit':transaction.type==='DEPOSIT'?'Deposit request':'Withdrawal request'}</h1><p>Request reference <span className="font-mono">{transaction.id}</span></p></div><span className="status-pill">{labels[transaction.status]||transaction.status}</span></header>
			<div className="account-content-grid">
				<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Request details</h2><p className="account-panel-subtitle">This application records internal ledger activity; no external payment is processed.</p></div><FileClock size={18} className="gold" aria-hidden="true"/></div><dl className="transaction-detail-grid"><Detail label="Amount requested" value={formatAmount(transaction.amount,transaction.currency)}/>{transaction.creditedAmount!==null&&transaction.creditedAmount!==undefined&&<Detail label="Amount credited" value={formatAmount(transaction.creditedAmount,transaction.currency)}/>}<Detail label="Payment method" value={transaction.method}/><Detail label="Submitted" value={formatDate(transaction.createdAt)}/><Detail label="Last updated" value={formatDate(transaction.updatedAt)}/><Detail label={transaction.accountMode==='REAL'?'Configured reference':'External reference'} value={transaction.accountMode==='REAL'&&transaction.status==='APPROVED'?`FUNDING:${transaction.id}:APPROVED`:transaction.transactionReference||transaction.referenceInfo||'Not provided'}/><Detail label={transaction.type==='DEPOSIT'?'Configured destination':'Withdrawal destination'} value={transaction.destinationInfo||'Not recorded'}/>{transaction.network&&<Detail label="Network" value={transaction.network}/ >}{transaction.senderInfo&&<Detail label="Sender information" value={transaction.senderInfo}/ >}{transaction.beneficiaryInfo&&<Detail label="Beneficiary" value={transaction.beneficiaryInfo}/ >}{transaction.note&&<Detail label="Your note" value={transaction.note}/ >}</dl></section>
				<aside className="account-panel card p-5"><div className="account-panel-title"><div><h2>Review status</h2><p className="account-panel-subtitle">{transaction.status==='APPROVED'?'The configured ledger credit is complete.':'This internal balance request awaits administrator review.'}</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div><dl className="space-y-4"><Detail label="Reviewed" value={formatDate(transaction.reviewedAt)}/><Detail label="Payment verification" value={transaction.verifiedAt?'Administrator reviewed attached information':'Not applicable to configured simulated credits'}/><Detail label="Administrator note" value={transaction.adminNote||'No note recorded'}/></dl>{transaction.type==='DEPOSIT'&&transaction.accountMode==='REAL'&&<p className="mt-5 text-xs leading-5 muted">SIMULATED / CONFIGURED REAL deposit. The amount is an internal ledger balance; no bank/card payment, custody, or external transfer occurred.</p>}</aside>
		</div>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Status history</h2><p className="account-panel-subtitle">Submission and administrator review events.</p></div><Clock3 size={18} className="gold" aria-hidden="true"/></div>{data.history.length?<ol className="activity-list">{data.history.map((entry,index)=><li className="activity-row" key={`${entry.action}-${entry.createdAt}-${index}`}><span className="activity-type">{entry.action.replaceAll('_',' ')}</span><span className="activity-reference">{formatDate(entry.createdAt)}</span><span className="muted">{entry.actor?.role==='ADMIN'?entry.actor.name||'Administrator':'You'}</span></li>)}</ol>:<p className="account-empty">Submitted {formatDate(transaction.createdAt)} · awaiting review.</p>}</section>
		</>}
	</main></>;
}

function Detail({label,value}:{label:string;value:string}){return <div><dt className="muted text-xs">{label}</dt><dd className="mt-1 break-words text-sm">{value}</dd></div>}