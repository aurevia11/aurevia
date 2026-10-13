'use client';

import {useRef,useState} from 'react';
import {Download} from 'lucide-react';
import html2canvas from 'html2canvas';
import {jsPDF} from 'jspdf';

export type ReceiptData={
	id:string;
	reference:string;
	status:'PENDING'|'APPROVED';
	accountMode?:'DEMO'|'REAL';
	createdAt:string;
	reviewedAt?:string|null;
	reviewedBy?:{name:string|null;email:string}|null;
	externalReference?:string|null;
	name:string;
	email:string;
	amount:number|string;
	currency:string;
	method:string;
	creditedAmount?:number|string;
};

const dateLabel=(value:string)=>new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(value));
const amountLabel=(value:number|string,currency:string)=>`${Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;

export default function ReceiptGenerator({receipt}:{receipt:ReceiptData}){
	const receiptRef=useRef<HTMLElement>(null);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const approved=receipt.status==='APPROVED';
	const fileName=`aurevia-${approved?'approval':'pending'}-${receipt.id}`;

	async function exportReceipt(format:'png'|'pdf'){
		if(!receiptRef.current||busy)return;
		setBusy(true);setError('');
		try{
			const canvas=await html2canvas(receiptRef.current,{scale:2,backgroundColor:'#ffffff',logging:false,useCORS:true});
			if(format==='png'){
				const link=document.createElement('a');link.download=`${fileName}.png`;link.href=canvas.toDataURL('image/png');link.click();
			}else{
				const pdf=new jsPDF({orientation:'portrait',unit:'px',format:[canvas.width,canvas.height]});
				pdf.addImage(canvas.toDataURL('image/png'),'PNG',0,0,canvas.width,canvas.height);
				pdf.save(`${fileName}.pdf`);
			}
		}catch{
			setError('This receipt could not be exported. Please try again.');
		}finally{setBusy(false)}
	}

	return <div className="grid min-w-0 gap-3">
		<article ref={receiptRef} className="w-full max-w-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-sm sm:p-8" aria-label={`${approved?'Approval':'Pending'} payment receipt`}>
			<header className="flex items-center justify-between gap-3 border-b border-slate-200 pb-5">
				<div className="flex items-center gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-full bg-slate-900 text-lg font-bold text-white">A</span><div><b className="block text-base">Aurevia Invest</b><span className="text-xs text-slate-500">Account services</span></div></div>
				<span className={`shrink-0 border px-3 py-1 text-xs font-bold ${approved?'border-emerald-200 bg-emerald-50 text-emerald-800':'border-amber-200 bg-amber-50 text-amber-800'}`}>{receipt.status}</span>
			</header>
			{receipt.accountMode==='REAL'&&<p className="mt-4 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">SIMULATED / CONFIGURED REAL DEPOSIT · No payment was processed and no money moved.</p>}
			<div className="py-5"><p className="text-xs font-semibold uppercase text-slate-500">Deposit Receipt</p><h3 className="mt-2 text-2xl font-semibold">{approved?'Deposit approved':'Deposit request received'}</h3><p className="mt-1 text-sm text-slate-500">{dateLabel(receipt.createdAt)}</p></div>
			<dl className="grid gap-x-8 border-y border-slate-200 py-4 text-sm sm:grid-cols-2">
				<div className="py-2"><dt className="text-xs text-slate-500">Transaction reference</dt><dd className="mt-1 break-all font-medium">{receipt.reference}</dd></div>
				{receipt.externalReference&&<div className="py-2"><dt className="text-xs text-slate-500">External payment reference</dt><dd className="mt-1 break-all font-medium">{receipt.externalReference}</dd></div>}
				<div className="py-2"><dt className="text-xs text-slate-500">Payment method</dt><dd className="mt-1 font-medium">{receipt.method}</dd></div>
				<div className="py-2"><dt className="text-xs text-slate-500">Account holder</dt><dd className="mt-1 break-words font-medium">{receipt.name||'Account holder'}</dd><dd className="break-all text-xs text-slate-500">{receipt.email}</dd></div>
				<div className="py-2"><dt className="text-xs text-slate-500">Amount requested</dt><dd className="mt-1 font-medium">{amountLabel(receipt.amount,receipt.currency)}</dd></div>
				{approved&&<>
					<div className="py-2"><dt className="text-xs text-slate-500">Credited amount</dt><dd className="mt-1 font-semibold text-emerald-800">{amountLabel(receipt.creditedAmount??receipt.amount,receipt.currency)}</dd></div>
					<div className="py-2"><dt className="text-xs text-slate-500">Approval date</dt><dd className="mt-1 font-medium">{dateLabel(receipt.reviewedAt||receipt.createdAt)}</dd></div>
					<div className="py-2 sm:col-span-2"><dt className="text-xs text-slate-500">Admin reference</dt><dd className="mt-1 break-all font-medium">{receipt.reference}</dd></div>
					{receipt.reviewedBy&&<div className="py-2 sm:col-span-2"><dt className="text-xs text-slate-500">Reviewed by</dt><dd className="mt-1 font-medium">{receipt.reviewedBy.name||receipt.reviewedBy.email}</dd>{receipt.reviewedBy.name&&<dd className="break-all text-xs text-slate-500">{receipt.reviewedBy.email}</dd>}</div>}
				</>}
			</dl>
			<p className="py-5 text-sm leading-6 text-slate-700">{receipt.accountMode==='REAL'?approved?'The configured simulated amount has been credited to your REAL account balance. No payment was processed.':'Your configured REAL balance credit request is awaiting administrator review. No payment was processed.':approved?'Payment has been successfully credited to your account.':'Your funding request has been received and is being reviewed.'}</p>
			<footer className="border-t border-slate-200 pt-3 text-xs text-slate-500">This is a computer-generated receipt from Aurevia Invest{receipt.accountMode==='REAL'?'. Simulated/configured internal ledger entry only.':''}</footer>
		</article>
		<div className="flex flex-wrap gap-2"><button type="button" className="btn min-h-10 bg-white/5" disabled={busy} onClick={()=>void exportReceipt('png')}><Download size={14}/>{busy?'Preparing…':'Download PNG'}</button><button type="button" className="btn min-h-10 bg-white/5" disabled={busy} onClick={()=>void exportReceipt('pdf')}><Download size={14}/>{busy?'Preparing…':'Download PDF'}</button></div>
		{error&&<p className="text-sm text-loss" role="alert">{error}</p>}
	</div>;
}