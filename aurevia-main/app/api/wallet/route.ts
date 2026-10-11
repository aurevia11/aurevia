import {NextResponse} from 'next/server';
import {Prisma,FundingStatus,FundingType,NotificationType,KycStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {sendSupportEmail} from '@/lib/email';
import {validateWithdrawal} from '@/lib/production-policy';
import {getFundingProviderReadiness} from '@/lib/providers/funding-provider';

const schema=z.object({
	type:z.nativeEnum(FundingType),
	paymentMethodId:z.string().min(1),
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

const reservingStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.PROCESSING];

export async function GET(){
	try{
		const user=await requireUser();
		const [accounts,transactions]=await Promise.all([
			db.ledgerAccount.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{currency:'asc'}}),
			db.fundingRequest.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{createdAt:'desc'},take:100,include:{paymentMethod:{select:{id:true,name:true}}}}),
		]);
		const balances=await Promise.all(accounts.map(async account=>({currency:account.currency,balance:await balance(db,account.id)})));
		const usdBalance=balances.find(item=>item.currency==='USD')?.balance??null;
		const safeTransactions=transactions.map(({receiptKey,...transaction})=>({...transaction,hasReceipt:!!receiptKey}));
		return NextResponse.json(jsonSafe({accountMode:user.accountMode,balance:usdBalance,balances,transactions:safeTransactions}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		console.error(`Wallet data unavailable (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Wallet data is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(req:Request){
	try{
		const user=await requireUser();
		const parsed=schema.parse(await req.json());
		const idempotencyKey=req.headers.get('Idempotency-Key');
		if(!idempotencyKey||idempotencyKey.length>128)return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		if(user.accountMode==='REAL'){
			const funding=await getFundingProviderReadiness();
			if(!funding.workflowEnabled)return NextResponse.json({error:'REAL_FUNDING_PROVIDER_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'private, no-store'}});
		}
		const currency=parsed.currency.toUpperCase();

		const result=await db.$transaction(async tx=>{
			const duplicate=await tx.fundingRequest.findUnique({where:{idempotencyKey}});
			if(duplicate){
				if(duplicate.userId!==user.id||duplicate.accountMode!==user.accountMode||duplicate.type!==parsed.type||!duplicate.amount.equals(parsed.amount)||duplicate.currency!==currency||duplicate.paymentMethodId!==parsed.paymentMethodId)throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {request:duplicate,replay:true};
			}
			const fundingUser=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,withdrawalEnabled:true,accountRestricted:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true},take:1}}});
			if(user.accountMode==='REAL'&&(fundingUser.kycStatus!==KycStatus.APPROVED||!fundingUser.kyc?.submittedAt||fundingUser.kycDocuments.length===0))throw new Error('REAL_KYC_REQUIRED');
			const method=await tx.paymentMethod.findUnique({where:{id:parsed.paymentMethodId}});
			const methodEnabled=!!method?.enabled&&(parsed.type==='DEPOSIT'?method.depositEnabled:method.withdrawalEnabled);
			const correctMode=method?.demoOnly===(user.accountMode==='DEMO');
			if(!method||!methodEnabled||!method.currencies.includes(currency)||!correctMode)throw new Error('PAYMENT_METHOD_UNAVAILABLE');
			const amount=new Prisma.Decimal(parsed.amount);
			if(amount.lt(method.minimumAmount)||(method.maximumAmount&&amount.gt(method.maximumAmount)))throw new Error('AMOUNT_OUT_OF_RANGE');
			if(parsed.type==='DEPOSIT'&&!method.demoOnly&&!method.destination&&!method.instructions)throw new Error('PAYMENT_INSTRUCTIONS_UNAVAILABLE');
			if(parsed.type==='WITHDRAWAL'){
				if(!method.demoOnly&&!parsed.destinationInfo)throw new Error('WITHDRAWAL_DESTINATION_REQUIRED');
				if(!method.demoOnly&&method.requiresNetwork&&!parsed.network)throw new Error('WITHDRAWAL_NETWORK_REQUIRED');
				const code=`USER:${user.id}:${user.accountMode}:${currency}`;
				const account=await tx.ledgerAccount.findUnique({where:{code}});
				const currentBalance=account?await balance(tx,account.id):new Prisma.Decimal(0);
				const pending=await tx.fundingRequest.aggregate({where:{userId:user.id,accountMode:user.accountMode,currency,type:FundingType.WITHDRAWAL,status:{in:reservingStatuses}},_sum:{amount:true}});
				const reserved=pending._sum.amount??new Prisma.Decimal(0);
				if(user.accountMode==='REAL')validateWithdrawal({balance:currentBalance.toString(),pending:reserved.toString(),amount:amount.toString(),withdrawalEnabled:fundingUser.withdrawalEnabled,accountRestricted:fundingUser.accountRestricted,kycStatus:fundingUser.kycStatus});
				else if(currentBalance.lt(amount.plus(reserved)))throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
			}
			const request=await tx.fundingRequest.create({data:{
				userId:user.id,
				type:parsed.type,
				method:method.name,
				amount,
				currency,
				status:FundingStatus.PENDING_REVIEW,
				accountMode:user.accountMode,
				paymentMethodId:method.id,
				idempotencyKey,
				transactionReference:parsed.transactionReference||null,
				referenceInfo:parsed.referenceInfo||null,
				senderInfo:parsed.senderInfo||null,
				destinationInfo:method.demoOnly?null:parsed.type==='DEPOSIT'?method.destination:parsed.destinationInfo,
				beneficiaryInfo:parsed.beneficiaryInfo||null,
				network:parsed.network||null,
				note:parsed.note||null,
			}});
			await tx.auditLog.create({data:{actorId:user.id,action:'FUNDING_SUBMITTED',entity:'FUNDING',entityId:request.id,metadata:{type:request.type,accountMode:request.accountMode,currency:request.currency,amount:request.amount.toString()}}});
			const notificationType=request.type===FundingType.DEPOSIT?NotificationType.DEPOSIT:NotificationType.WITHDRAWAL;
			await createNotification(tx,{userId:user.id,type:notificationType,title:`${request.type==='DEPOSIT'?'Deposit':'Withdrawal'} submitted`,message:`Your ${request.type.toLowerCase()} request is pending administrator review. No transfer has been confirmed.`,dedupeKey:`funding:${request.id}:submitted`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:`/wallet/transactions/${request.id}`});
			await notifyActiveAdmins(tx,{type:notificationType,title:`New ${request.type.toLowerCase()} request`,message:`A ${request.accountMode.toLowerCase()} ${request.type.toLowerCase()} request is awaiting review. No payment is confirmed.`,dedupeKey:`funding:${request.id}:admin`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:'/admin'});
			return {request,replay:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		let emailDelivery:'sent'|'not-configured'|'failed'='not-configured';
		if(!result.replay){
			const delivery=await sendSupportEmail(`New ${result.request.type.toLowerCase()} request`,[`Request: ${result.request.id}`,`User: ${user.id}`,`Account mode: ${result.request.accountMode}`,`Amount: ${result.request.amount.toString()} ${result.request.currency}`,`Status: ${result.request.status}`].join('\n'));
			emailDelivery=delivery.sent?'sent':delivery.reason||'failed';
		}
		return NextResponse.json({...jsonSafe(result.request),emailDelivery},{status:result.replay?200:201});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Check the funding details and try again.'},{status:400});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This submission was already received.'},{status:409});
		const known=['IDEMPOTENCY_KEY_REUSED','PAYMENT_METHOD_UNAVAILABLE','AMOUNT_OUT_OF_RANGE','PAYMENT_INSTRUCTIONS_UNAVAILABLE','WITHDRAWAL_DESTINATION_REQUIRED','WITHDRAWAL_NETWORK_REQUIRED','INSUFFICIENT_AVAILABLE_BALANCE','WITHDRAWAL_DISABLED','ACCOUNT_RESTRICTED','REAL_KYC_REQUIRED','INVALID_AMOUNT'];
		if(error instanceof Error&&known.includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:error.message==='IDEMPOTENCY_KEY_REUSED'?409:error.message==='ACCOUNT_RESTRICTED'||error.message==='WITHDRAWAL_DISABLED'||error.message==='REAL_KYC_REQUIRED'?403:400});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017','P2021','P2022'].includes(code))return NextResponse.json({error:'Funding service is temporarily unavailable.'},{status:503});
		console.error(`Funding request failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to submit this funding request.'},{status:500});
	}
}