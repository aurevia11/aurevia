import {NextResponse} from 'next/server';
import {AccountMode,FundingStatus,FundingType,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureSystemAccount,ensureUserLedger,postDoubleEntry,balance} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {sendSupportEmail} from '@/lib/email';

const schema=z.object({id:z.string().min(1),decision:z.enum(['APPROVED','REJECTED']),note:z.string().trim().max(500).optional()});
const pendingStatuses:FundingStatus[]=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW];

export async function GET(req:Request){
	try{
		await requireAdmin();
		const includeHistory=new URL(req.url).searchParams.get('history')==='true';
		const settlementQueue=new URL(req.url).searchParams.get('settlement')==='true';
		const where=settlementQueue?{type:FundingType.WITHDRAWAL,accountMode:AccountMode.REAL,status:FundingStatus.APPROVED,settlementReference:null}:includeHistory?undefined:{status:{in:pendingStatuses}};
		const requests=await db.fundingRequest.findMany({where,include:{user:{select:{email:true,name:true}},paymentMethod:{select:{name:true}}},orderBy:{createdAt:includeHistory?'desc':'asc'},take:includeHistory?200:undefined});
		const safeRequests=requests.map(({receiptKey,...request})=>({...request,hasReceipt:!!receiptKey}));
		return NextResponse.json(jsonSafe(safeRequests),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}

export async function PATCH(req:Request){
	try{
		const admin=await requireAdmin();
		const input=schema.parse(await req.json());
		const candidate=await db.fundingRequest.findUnique({where:{id:input.id},select:{id:true,userId:true,type:true,accountMode:true,status:true}});
		if(candidate?.accountMode===AccountMode.REAL&&input.decision==='APPROVED'){
			const isDeposit=candidate.type===FundingType.DEPOSIT;
			await db.auditLog.create({data:{actorId:admin.id,action:isDeposit?'REAL_DEPOSIT_APPROVAL_BLOCKED':'REAL_WITHDRAWAL_APPROVAL_BLOCKED',entity:'FUNDING',entityId:candidate.id,metadata:{accountMode:AccountMode.REAL,reason:isDeposit?'PAYMENT_PROVIDER_CONFIRMATION_UNAVAILABLE':'PAYOUT_PROVIDER_UNAVAILABLE'}}});
			return NextResponse.json({error:isDeposit?'REAL_DEPOSIT_PROVIDER_UNAVAILABLE':'REAL_WITHDRAWAL_PROVIDER_UNAVAILABLE'},{status:409});
		}
		const request=await db.$transaction(async tx=>{
			const current=await tx.fundingRequest.findUnique({where:{id:input.id}});
			if(!current||!pendingStatuses.includes(current.status))throw new Error('FUNDING_NOT_PENDING');
			if(current.accountMode===AccountMode.REAL){
				const fundingUser=await tx.user.findUnique({where:{id:current.userId},select:{kycStatus:true,withdrawalEnabled:true,accountRestricted:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true},take:1}}});
				if(fundingUser?.kycStatus!=='APPROVED'||!fundingUser.kyc?.submittedAt||fundingUser.kycDocuments.length===0)throw new Error('REAL_KYC_REQUIRED');
				if(current.type===FundingType.WITHDRAWAL&&(!fundingUser.withdrawalEnabled||fundingUser.accountRestricted))throw new Error('WITHDRAWAL_RESTRICTED');
			}
			const changed=await tx.fundingRequest.updateMany({where:{id:current.id,status:{in:pendingStatuses}},data:{status:input.decision,adminNote:input.note||null,reviewedAt:new Date(),verifiedAt:input.decision==='APPROVED'&&current.type===FundingType.DEPOSIT?new Date():null}});
			if(changed.count!==1)throw new Error('FUNDING_ALREADY_REVIEWED');
			if(input.decision==='APPROVED'){
				const account=await ensureUserLedger(tx,current.userId,current.accountMode,current.currency);
				const systemCode=`SYSTEM:EXTERNAL:${current.accountMode}:${current.currency}`;
				const system=await ensureSystemAccount(tx,systemCode,'External funds',current.currency,current.accountMode);
				if(current.type===FundingType.DEPOSIT){
					await postDoubleEntry(tx,{reference:`FUNDING:${current.id}:APPROVED`,description:current.accountMode===AccountMode.REAL?'Admin manually verified deposit':'Approved demo deposit',debitAccountId:system.id,creditAccountId:account.id,amount:current.amount});
				}else{
					const available=await balance(tx,account.id);
					if(available.lt(current.amount))throw new Error('INSUFFICIENT_FUNDS');
					await postDoubleEntry(tx,{reference:`FUNDING:${current.id}:APPROVED`,description:'Admin approved withdrawal request',debitAccountId:account.id,creditAccountId:system.id,amount:current.amount});
				}
			}
			const updated=await tx.fundingRequest.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:`FUNDING_${input.decision}`,entity:'FUNDING',entityId:updated.id,metadata:{type:updated.type,accountMode:updated.accountMode,currency:updated.currency,amount:updated.amount.toString()}}});
			const notificationType=updated.type===FundingType.DEPOSIT?NotificationType.DEPOSIT:NotificationType.WITHDRAWAL;
			const decisionLabel=input.decision==='APPROVED'?'approved':'rejected';
			await createNotification(tx,{userId:updated.userId,type:notificationType,title:`${updated.type==='DEPOSIT'?'Deposit':'Withdrawal'} ${decisionLabel}`,message:updated.type==='DEPOSIT'&&input.decision==='APPROVED'&&updated.accountMode===AccountMode.REAL?'Your deposit was manually verified by an administrator and posted to your real-account ledger. This is not a blockchain confirmation.':updated.type==='DEPOSIT'&&input.decision==='APPROVED'?'Your demo deposit request was approved and posted to your demo ledger.':`Your ${updated.type.toLowerCase()} request was ${decisionLabel}.${input.note?` Admin note: ${input.note}`:''}`,dedupeKey:`funding:${updated.id}:${decisionLabel}`,relatedEntity:'FUNDING',relatedId:updated.id,actionUrl:`/wallet/transactions/${updated.id}`});
			return updated;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		const user=await db.user.findUnique({where:{id:request.userId},select:{email:true}});
		const delivery=user?await sendSupportEmail(`Funding request ${input.decision.toLowerCase()}`,[`Request: ${request.id}`,`User: ${request.userId}`,`Type: ${request.type}`,`Mode: ${request.accountMode}`,`Status: ${request.status}`,`A ledger entry was posted only if the approved review transaction completed.`].join('\n')):{sent:false as const,reason:'failed' as const};
		const {receiptKey,...safeRequest}=request;
		return NextResponse.json({...jsonSafe(safeRequest),hasReceipt:!!receiptKey,emailDelivery:delivery.sent?'sent':delivery.reason||'failed'},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid review details.'},{status:400});
		if(error instanceof Error&&['FUNDING_NOT_PENDING','FUNDING_ALREADY_REVIEWED','INSUFFICIENT_FUNDS','REAL_KYC_REQUIRED','WITHDRAWAL_RESTRICTED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
		return NextResponse.json({error:'Funding review failed.'},{status:400});
	}
}