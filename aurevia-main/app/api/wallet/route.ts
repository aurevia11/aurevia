import {NextResponse} from 'next/server';
import {AccountMode,Prisma,FundingStatus,FundingType,NotificationType} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureUserLedger,initializeRealSimulatedAccount} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {sendSupportEmail} from '@/lib/email';
import {validateWithdrawal} from '@/lib/production-policy';
import {FundingEvidenceError,maxFundingEvidenceBytes,validateFundingEvidence} from '@/lib/funding-evidence';
import {createPrivateObjectKey,deletePrivateObject,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';
import {isBitcoinMainnetAddress,SIMULATED_BTC_ADDRESS_SETTING} from '@/lib/config/simulated-bitcoin-address';

const schema=z.object({
	type:z.nativeEnum(FundingType),
	paymentMethodId:z.string().min(1).optional(),
	amount:z.number().positive().max(100000000),
	currency:z.enum(SUPPORTED_CURRENCIES),
	transactionReference:z.string().trim().max(180).optional(),
	referenceInfo:z.string().trim().max(500).optional(),
	senderInfo:z.string().trim().max(300).optional(),
	destinationInfo:z.string().trim().max(500).optional(),
	beneficiaryInfo:z.string().trim().max(300).optional(),
	network:z.string().trim().max(80).optional(),
	note:z.string().trim().max(500).optional(),
	simulatedBitcoinAddress:z.string().max(90).optional(),
	simulatedBitcoinAddressAcknowledged:z.boolean().optional(),
});

const reservingStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING];

export async function GET(){
	try{
		const user=await requireUser();
		if(user.accountMode===AccountMode.REAL)await db.$transaction(tx=>initializeRealSimulatedAccount(tx,user.id));
		await ensureUserLedger(db,user.id,user.accountMode,'USD');
		const [accounts,transactions]=await Promise.all([
			db.ledgerAccount.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{currency:'asc'}}),
			db.fundingRequest.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{createdAt:'desc'},take:100,include:{paymentMethod:{select:{id:true,name:true}},user:{select:{name:true,email:true}}}}),
		]);
		const balances=await Promise.all(accounts.map(async account=>({currency:account.currency,balance:await balance(db,account.id)})));
		const accountIds=accounts.map(account=>account.id);
		const adminLedgerTransactions=accountIds.length?await db.ledgerTransaction.findMany({
			where:{reference:{startsWith:`ADMIN:${user.accountMode}:${user.id}:`},entries:{some:{accountId:{in:accountIds}}}},
			orderBy:{createdAt:'desc'},
			take:100,
			include:{entries:{where:{accountId:{in:accountIds}},select:{type:true,amount:true,account:{select:{currency:true}}}}},
		}):[];
		const adminLedgerReceipts=adminLedgerTransactions.flatMap(transaction=>{
			const entry=transaction.entries[0];
			return entry?[{id:transaction.id,reference:transaction.reference,description:transaction.description,type:entry.type,amount:entry.amount,currency:entry.account.currency,createdAt:transaction.createdAt}]:[];
		});
		const usdBalance=balances.find(item=>item.currency==='USD')?.balance??null;
		const approvals=transactions.length?await db.auditLog.findMany({where:{entity:'FUNDING',entityId:{in:transactions.map(transaction=>transaction.id)},action:'FUNDING_APPROVED'},select:{entityId:true,createdAt:true,metadata:true,actor:{select:{name:true,email:true}}},orderBy:{createdAt:'desc'}}):[];
		const approvalByRequest=new Map();
		for(const approval of approvals)if(approval.entityId&&!approvalByRequest.has(approval.entityId)){
			const metadata=approval.metadata&&typeof approval.metadata==='object'&&!Array.isArray(approval.metadata)?approval.metadata as Record<string,unknown>:{};
			approvalByRequest.set(approval.entityId,{reviewedAt:approval.createdAt,reviewedBy:approval.actor,previousBalance:typeof metadata.previousBalance==='string'?metadata.previousBalance:null,resultingBalance:typeof metadata.resultingBalance==='string'?metadata.resultingBalance:null});
		}
		const safeTransactions=transactions.map(({receiptKey,...transaction})=>({...transaction,hasReceipt:!!receiptKey,...(approvalByRequest.get(transaction.id)||{})}));
		return NextResponse.json(jsonSafe({accountMode:user.accountMode,balance:usdBalance,balances,transactions:safeTransactions,adminLedgerReceipts}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		console.error(`Wallet data unavailable (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Wallet data is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(req:Request){
	let receiptKey:string|undefined;
	let ownerId:string|undefined;
	let evidenceMetadata:{fileType:string;fileSize:number}|undefined;
	try{
		const user=await requireUser();
		ownerId=user.id;
		let body:unknown;
		let evidenceFile:File|null=null;
		if(req.headers.get('content-type')?.includes('multipart/form-data')){
			if(Number(req.headers.get('content-length')||0)>maxFundingEvidenceBytes+64*1024)return NextResponse.json({error:'Evidence must be 5 MB or smaller.'},{status:413});
			const form=await req.formData();
			const payload=form.get('payload');
			if(typeof payload!=='string')return NextResponse.json({error:'Funding details are required.'},{status:400});
			try{body=JSON.parse(payload)}catch{return NextResponse.json({error:'Funding details are invalid.'},{status:400})}
			const file=form.get('evidence');
			if(file instanceof File)evidenceFile=file;
		}else{
			body=await req.json();
		}
		const parsed=schema.parse(body);
		const idempotencyKey=req.headers.get('Idempotency-Key');
		if(!idempotencyKey||idempotencyKey.length>128)return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		if(parsed.type===FundingType.DEPOSIT){
			const access=await db.user.findUniqueOrThrow({where:{id:user.id},select:{depositEnabled:true}});
			if(!access.depositEnabled)throw new Error('DEPOSITS_DISABLED');
		}
		if(parsed.paymentMethodId)return NextResponse.json({error:'External payment methods are disabled. Submit an internal simulated request without a payment method.'},{status:400});
		if(parsed.type===FundingType.DEPOSIT&&evidenceFile){
			if(evidenceFile.size===0)throw new FundingEvidenceError('Choose a non-empty evidence file.',400);
			if(evidenceFile.size>maxFundingEvidenceBytes)throw new FundingEvidenceError('Evidence must be 5 MB or smaller.',413);
			const bytes=Buffer.from(await evidenceFile.arrayBuffer());
			const {contentType}=validateFundingEvidence(evidenceFile,bytes,{imagesOnly:true});
			evidenceMetadata={fileType:contentType,fileSize:bytes.length};
			receiptKey=createPrivateObjectKey('receipt',user.id,contentType);
			await uploadPrivateObject('receipt',user.id,receiptKey,bytes,contentType);
		}
		if(parsed.type==='WITHDRAWAL'){
			const controls=await db.user.findUniqueOrThrow({where:{id:user.id},select:{withdrawalEnabled:true,accountRestricted:true}});
			if(!controls.withdrawalEnabled)throw new Error('WITHDRAWAL_DISABLED');
			if(controls.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
		}
		const currency=parsed.currency.toUpperCase();

		const result=await db.$transaction(async tx=>{
			const duplicate=await tx.fundingRequest.findUnique({where:{idempotencyKey}});
			if(duplicate){
				if(duplicate.userId!==user.id||duplicate.accountMode!==user.accountMode||duplicate.type!==parsed.type||!duplicate.amount.equals(parsed.amount)||duplicate.currency!==currency||duplicate.paymentMethodId!==null)throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {request:duplicate,replay:true};
			}
			let simulatedBitcoinAddressAcknowledged=false;
			if(parsed.type===FundingType.DEPOSIT){
				const configured=await tx.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
				const address=configured?.value.trim()||'';
				if(address&&!isBitcoinMainnetAddress(address))throw new Error('SIMULATED_BTC_ADDRESS_INVALID');
				if(address){
					if(parsed.simulatedBitcoinAddress!==address)throw new Error('SIMULATED_BTC_ADDRESS_CHANGED');
					if(!parsed.simulatedBitcoinAddressAcknowledged)throw new Error('SIMULATED_BTC_ADDRESS_ACK_REQUIRED');
					simulatedBitcoinAddressAcknowledged=true;
				}
			}
			const fundingUser=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true}});
			if(parsed.type==='DEPOSIT'&&!fundingUser.depositEnabled)throw new Error('DEPOSITS_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&!fundingUser.withdrawalEnabled)throw new Error('WITHDRAWAL_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&fundingUser.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
			if(user.accountMode==='REAL'&&parsed.type==='DEPOSIT'&&parsed.paymentMethodId&&fundingUser.kycStatus!=='APPROVED')throw new Error('REAL_KYC_REQUIRED');
			const amount=new Prisma.Decimal(parsed.amount);
			if(parsed.type==='WITHDRAWAL'){
				const account=await ensureUserLedger(tx,user.id,user.accountMode,currency);
				const currentBalance=await balance(tx,account.id);
				const pending=await tx.fundingRequest.aggregate({where:{userId:user.id,accountMode:user.accountMode,currency,type:FundingType.WITHDRAWAL,status:{in:reservingStatuses}},_sum:{amount:true}});
				const reserved=pending._sum.amount??new Prisma.Decimal(0);
				if(user.accountMode==='REAL')validateWithdrawal({balance:currentBalance.toString(),pending:reserved.toString(),amount:amount.toString(),withdrawalEnabled:fundingUser.withdrawalEnabled,accountRestricted:fundingUser.accountRestricted,kycStatus:fundingUser.kycStatus,simulated:true});
				else if(currentBalance.lt(amount.plus(reserved)))throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
			}
			const request=await tx.fundingRequest.create({data:{
				userId:user.id,
				type:parsed.type,
				method:`Internal simulated ${parsed.type.toLowerCase()}`,
				amount,
				currency,
				status:FundingStatus.PENDING_REVIEW,
				accountMode:user.accountMode,
				paymentMethodId:null,
				idempotencyKey,
				transactionReference:parsed.transactionReference||null,
				referenceInfo:parsed.referenceInfo||null,
				senderInfo:parsed.senderInfo||null,
				destinationInfo:null,
				beneficiaryInfo:null,
				network:null,
				note:parsed.note||null,
				receiptKey:receiptKey||null,
			}});
			await tx.auditLog.create({data:{actorId:user.id,action:'FUNDING_SUBMITTED',entity:'FUNDING',entityId:request.id,metadata:{type:request.type,accountMode:request.accountMode,currency:request.currency,amount:request.amount.toString(),hasEvidence:!!receiptKey,simulatedBitcoinAddressAcknowledged}}});
			if(receiptKey)await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_RECEIPT_UPLOADED',entity:'FUNDING',entityId:request.id,metadata:{accountMode:request.accountMode,...evidenceMetadata}}});
			const notificationType=request.type===FundingType.DEPOSIT?NotificationType.DEPOSIT:NotificationType.WITHDRAWAL;
			const disclosure=request.accountMode===AccountMode.REAL?' This is a simulated ledger request; no external money moves.':'';
			await createNotification(tx,{userId:user.id,type:notificationType,title:`${request.type==='DEPOSIT'?'Deposit':'Withdrawal'} submitted`,message:`Your ${request.type.toLowerCase()} request is pending administrator review. No transfer has been confirmed.${disclosure}`,dedupeKey:`funding:${request.id}:submitted`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:`/wallet/transactions/${request.id}`});
			await notifyActiveAdmins(tx,{type:notificationType,title:`New ${request.type.toLowerCase()} request`,message:`A ${request.accountMode.toLowerCase()} ${request.type.toLowerCase()} request is awaiting review${receiptKey?' with payment evidence':''}.${request.accountMode===AccountMode.REAL?' This is simulated; no external money moves.':' No payment is confirmed.'}`,dedupeKey:`funding:${request.id}:admin`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:'/admin'});
			return {request,replay:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
		if(result.replay&&receiptKey)await deletePrivateObject('receipt',user.id,receiptKey);
		const {receiptKey:storedReceiptKey,...safeRequest}=result.request;
		receiptKey=undefined;
		let emailDelivery:'sent'|'not-configured'|'failed'='not-configured';
		if(!result.replay){
			const delivery=await sendSupportEmail(`New ${result.request.type.toLowerCase()} request`,[`Request: ${result.request.id}`,`User: ${user.id}`,`Account mode: ${result.request.accountMode}`,`Amount: ${result.request.amount.toString()} ${result.request.currency}`,`Status: ${result.request.status}`].join('\n'));
			emailDelivery=delivery.sent?'sent':delivery.reason||'failed';
		}
		return NextResponse.json({...jsonSafe(safeRequest),hasReceipt:!!storedReceiptKey,emailDelivery},{status:result.replay?200:201});
	}catch(error){
		if(receiptKey&&ownerId)await deletePrivateObject('receipt',ownerId,receiptKey);
		if(error instanceof ZodError)return NextResponse.json({error:'Check the funding details and try again.'},{status:400});
		if(error instanceof FundingEvidenceError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This submission was already received.'},{status:409});
		if(error instanceof Error&&error.message==='SIMULATED_BTC_ADDRESS_ACK_REQUIRED')return NextResponse.json({error:'Copy or scan the configured simulated Bitcoin address and confirm before submitting this deposit.'},{status:400});
		if(error instanceof Error&&error.message==='SIMULATED_BTC_ADDRESS_CHANGED')return NextResponse.json({error:'The simulated Bitcoin display address changed. Refresh the wallet and confirm the current address.'},{status:409});
		if(error instanceof Error&&error.message==='SIMULATED_BTC_ADDRESS_INVALID')return NextResponse.json({error:'The administrator-configured simulated Bitcoin display address is invalid. Contact support.'},{status:503});
		const known=['IDEMPOTENCY_KEY_REUSED','PAYMENT_METHOD_UNAVAILABLE','AMOUNT_OUT_OF_RANGE','PAYMENT_INSTRUCTIONS_UNAVAILABLE','WITHDRAWAL_DESTINATION_REQUIRED','WITHDRAWAL_NETWORK_REQUIRED','INSUFFICIENT_AVAILABLE_BALANCE','DEPOSITS_DISABLED','WITHDRAWAL_DISABLED','ACCOUNT_RESTRICTED','REAL_KYC_REQUIRED','INVALID_AMOUNT','FIRST_TRADE_REQUIRED'];
		if(error instanceof Error&&known.includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:error.message==='IDEMPOTENCY_KEY_REUSED'?409:error.message==='DEPOSITS_DISABLED'||error.message==='ACCOUNT_RESTRICTED'||error.message==='WITHDRAWAL_DISABLED'||error.message==='REAL_KYC_REQUIRED'||error.message==='FIRST_TRADE_REQUIRED'?403:400});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017','P2021','P2022'].includes(code))return NextResponse.json({error:'Funding service is temporarily unavailable.'},{status:503});
		console.error(`Funding request failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to submit this funding request.'},{status:500});
	}
}