import {NextResponse} from 'next/server';
import {Prisma,FundingStatus,FundingType,InvestmentStatus,NotificationType,KycStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureUserLedger} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {sendSupportEmail} from '@/lib/email';
import {validateWithdrawal} from '@/lib/production-policy';
import {getFundingProviderReadiness} from '@/lib/providers/funding-provider';
import {FundingEvidenceError,maxFundingEvidenceBytes,validateFundingEvidence} from '@/lib/funding-evidence';
import {createPrivateObjectKey,deletePrivateObject,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';

const schema=z.object({
	type:z.nativeEnum(FundingType),
	paymentMethodId:z.string().min(1).optional(),
	amount:z.number().positive().max(100000000),
	currency:z.string().trim().regex(/^[A-Za-z]{3,10}$/),
	transactionReference:z.string().trim().max(180).optional(),
	referenceInfo:z.string().trim().max(500).optional(),
	senderInfo:z.string().trim().max(300).optional(),
	destinationInfo:z.string().trim().max(500).optional(),
	beneficiaryInfo:z.string().trim().max(300).optional(),
	network:z.string().trim().max(80).optional(),
	note:z.string().trim().max(500).optional(),
});

const reservingStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING];

export async function GET(){
	try{
		const user=await requireUser();
		await ensureUserLedger(db,user.id,user.accountMode,'USD');
		const [accounts,transactions]=await Promise.all([
			db.ledgerAccount.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{currency:'asc'}}),
			db.fundingRequest.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{createdAt:'desc'},take:100,include:{paymentMethod:{select:{id:true,name:true}},user:{select:{name:true,email:true}}}}),
		]);
		const balances=await Promise.all(accounts.map(async account=>({currency:account.currency,balance:await balance(db,account.id)})));
		const usdBalance=balances.find(item=>item.currency==='USD')?.balance??null;
		const approvals=transactions.length?await db.auditLog.findMany({where:{entity:'FUNDING',entityId:{in:transactions.map(transaction=>transaction.id)},action:'FUNDING_APPROVED'},select:{entityId:true,createdAt:true,actor:{select:{name:true,email:true}}},orderBy:{createdAt:'desc'}}):[];
		const approvalByRequest=new Map();
		for(const approval of approvals)if(approval.entityId&&!approvalByRequest.has(approval.entityId))approvalByRequest.set(approval.entityId,{reviewedAt:approval.createdAt,reviewedBy:approval.actor});
		const safeTransactions=transactions.map(({receiptKey,...transaction})=>({...transaction,hasReceipt:!!receiptKey,...(approvalByRequest.get(transaction.id)||{})}));
		return NextResponse.json(jsonSafe({accountMode:user.accountMode,balance:usdBalance,balances,transactions:safeTransactions}),{headers:{'Cache-Control':'private, no-store'}});
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
		if(parsed.type===FundingType.DEPOSIT){
			if(!evidenceFile)return NextResponse.json({error:'Attach a payment screenshot before submitting a deposit request.'},{status:400});
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
		if(user.accountMode==='REAL'&&parsed.type==='WITHDRAWAL'){
			const funding=await getFundingProviderReadiness();
			if(!funding.workflowEnabled)return NextResponse.json({error:'REAL_FUNDING_PROVIDER_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'private, no-store'}});
		}
		const currency=parsed.currency.toUpperCase();

		const result=await db.$transaction(async tx=>{
			const duplicate=await tx.fundingRequest.findUnique({where:{idempotencyKey}});
			if(duplicate){
				if(duplicate.userId!==user.id||duplicate.accountMode!==user.accountMode||duplicate.type!==parsed.type||!duplicate.amount.equals(parsed.amount)||duplicate.currency!==currency||duplicate.paymentMethodId!==(parsed.paymentMethodId||null))throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {request:duplicate,replay:true};
			}
			const fundingUser=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true},take:1}}});
			if(parsed.type==='DEPOSIT'&&!fundingUser.depositEnabled)throw new Error('DEPOSITS_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&!fundingUser.withdrawalEnabled)throw new Error('WITHDRAWAL_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&fundingUser.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
			if(user.accountMode==='REAL'&&(fundingUser.kycStatus!==KycStatus.APPROVED||!fundingUser.kyc?.submittedAt||fundingUser.kycDocuments.length===0))throw new Error('REAL_KYC_REQUIRED');
			const completedInvestment=await tx.investmentRequest?.findFirst?.({where:{userId:user.id,accountMode:user.accountMode,status:{in:[InvestmentStatus.COMPLETED,InvestmentStatus.SETTLED]}},select:{id:true}}) ?? null;
			const method=parsed.paymentMethodId?await tx.paymentMethod.findUnique({where:{id:parsed.paymentMethodId}}):null;
			const manualRealDeposit=user.accountMode==='REAL'&&parsed.type==='DEPOSIT'&&!parsed.paymentMethodId;
			const methodEnabled=!!method?.enabled&&(parsed.type==='DEPOSIT'?method.depositEnabled:method.withdrawalEnabled);
			const correctMode=method?.demoOnly===(user.accountMode==='DEMO');
			if(!manualRealDeposit&&(!method||!methodEnabled||!method.currencies.includes(currency)||!correctMode))throw new Error('PAYMENT_METHOD_UNAVAILABLE');
			const amount=new Prisma.Decimal(parsed.amount);
			if(parsed.type==='WITHDRAWAL'&&method&&(amount.lt(method.minimumAmount)||(method.maximumAmount&&amount.gt(method.maximumAmount))))throw new Error('AMOUNT_OUT_OF_RANGE');
			if(parsed.type==='DEPOSIT'&&method&&!method.demoOnly&&!method.destination&&!method.instructions)throw new Error('PAYMENT_INSTRUCTIONS_UNAVAILABLE');
			if(parsed.type==='WITHDRAWAL'){
				const withdrawalMethod=method!;
				if(!completedInvestment)throw new Error('FIRST_TRADE_REQUIRED');
				if(!withdrawalMethod.demoOnly&&!parsed.destinationInfo)throw new Error('WITHDRAWAL_DESTINATION_REQUIRED');
				if(!withdrawalMethod.demoOnly&&withdrawalMethod.requiresNetwork&&!parsed.network)throw new Error('WITHDRAWAL_NETWORK_REQUIRED');
				const code=`USER:${user.id}:${user.accountMode}:${currency}`;
				const account=await tx.ledgerAccount.findUnique({where:{code}});
				const currentBalance=account?await balance(tx,account.id):new Prisma.Decimal(0);
				const pending=await tx.fundingRequest.aggregate({where:{userId:user.id,accountMode:user.accountMode,currency,type:FundingType.WITHDRAWAL,status:{in:reservingStatuses}},_sum:{amount:true}});
				const reserved=pending._sum.amount??new Prisma.Decimal(0);
				if(user.accountMode==='REAL')validateWithdrawal({balance:currentBalance.toString(),pending:reserved.toString(),amount:amount.toString(),withdrawalEnabled:fundingUser.withdrawalEnabled,accountRestricted:fundingUser.accountRestricted,kycStatus:fundingUser.kycStatus,hasCompletedInvestment:true});
				else if(currentBalance.lt(amount.plus(reserved)))throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
			}
			const request=await tx.fundingRequest.create({data:{
				userId:user.id,
				type:parsed.type,
				method:method?.name||'Manual admin review',
				amount,
				currency,
				status:FundingStatus.PENDING_REVIEW,
				accountMode:user.accountMode,
				paymentMethodId:method?.id||null,
				idempotencyKey,
				transactionReference:parsed.transactionReference||null,
				referenceInfo:parsed.referenceInfo||null,
				senderInfo:parsed.senderInfo||null,
				destinationInfo:method?.demoOnly?null:method?parsed.type==='DEPOSIT'?method.destination:parsed.destinationInfo:parsed.destinationInfo||null,
				beneficiaryInfo:parsed.beneficiaryInfo||null,
				network:parsed.network||null,
				note:parsed.note||null,
				receiptKey:receiptKey||null,
			}});
			await tx.auditLog.create({data:{actorId:user.id,action:'FUNDING_SUBMITTED',entity:'FUNDING',entityId:request.id,metadata:{type:request.type,accountMode:request.accountMode,currency:request.currency,amount:request.amount.toString(),hasEvidence:!!receiptKey}}});
			if(receiptKey)await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_RECEIPT_UPLOADED',entity:'FUNDING',entityId:request.id,metadata:{accountMode:request.accountMode,...evidenceMetadata}}});
			const notificationType=request.type===FundingType.DEPOSIT?NotificationType.DEPOSIT:NotificationType.WITHDRAWAL;
			await createNotification(tx,{userId:user.id,type:notificationType,title:`${request.type==='DEPOSIT'?'Deposit':'Withdrawal'} submitted`,message:`Your ${request.type.toLowerCase()} request is pending administrator review. No transfer has been confirmed.`,dedupeKey:`funding:${request.id}:submitted`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:`/wallet/transactions/${request.id}`});
			await notifyActiveAdmins(tx,{type:notificationType,title:`New ${request.type.toLowerCase()} request`,message:`A ${request.accountMode.toLowerCase()} ${request.type.toLowerCase()} request is awaiting review${receiptKey?' with payment evidence':''}. No payment is confirmed.`,dedupeKey:`funding:${request.id}:admin`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:'/admin'});
			return {request,replay:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
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
		const known=['IDEMPOTENCY_KEY_REUSED','PAYMENT_METHOD_UNAVAILABLE','AMOUNT_OUT_OF_RANGE','PAYMENT_INSTRUCTIONS_UNAVAILABLE','WITHDRAWAL_DESTINATION_REQUIRED','WITHDRAWAL_NETWORK_REQUIRED','INSUFFICIENT_AVAILABLE_BALANCE','DEPOSITS_DISABLED','WITHDRAWAL_DISABLED','ACCOUNT_RESTRICTED','REAL_KYC_REQUIRED','INVALID_AMOUNT','FIRST_TRADE_REQUIRED'];
		if(error instanceof Error&&known.includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:error.message==='IDEMPOTENCY_KEY_REUSED'?409:error.message==='DEPOSITS_DISABLED'||error.message==='ACCOUNT_RESTRICTED'||error.message==='WITHDRAWAL_DISABLED'||error.message==='REAL_KYC_REQUIRED'||error.message==='FIRST_TRADE_REQUIRED'?403:400});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017','P2021','P2022'].includes(code))return NextResponse.json({error:'Funding service is temporarily unavailable.'},{status:503});
		console.error(`Funding request failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to submit this funding request.'},{status:500});
	}
}