import {AccountMode,EntryType,FundingStatus,FundingType,NotificationType,Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';
import {createNotification} from '@/lib/notifications';

const schema=z.object({
	id:z.string().min(1),
	action:z.enum(['PROCESS','COMPLETE','FAIL','REVERSE']),
	note:z.string().trim().min(3).max(500),
});

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		const input=schema.parse(await request.json());
		const idempotencyKey=request.headers.get('Idempotency-Key')||'';
		if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		const result=await db.$transaction(async tx=>{
			const actionName=`SIMULATED_WITHDRAWAL_${input.action}`;
			const replay=await tx.auditLog.findFirst({where:{entity:'FUNDING',entityId:input.id,action:actionName,metadata:{path:['idempotencyKey'],equals:idempotencyKey}},select:{id:true}});
			const current=await tx.fundingRequest.findUnique({where:{id:input.id}});
			if(!current||current.type!==FundingType.WITHDRAWAL||current.accountMode!==AccountMode.DEMO)throw new Error('SIMULATED_WITHDRAWAL_REQUIRED');
			if(replay)return {request:current,replayed:true};
			const validTransition=input.action==='PROCESS'?current.status===FundingStatus.APPROVED:input.action==='COMPLETE'?current.status===FundingStatus.PROCESSING:input.action==='FAIL'?(current.status===FundingStatus.APPROVED||current.status===FundingStatus.PROCESSING):current.status===FundingStatus.COMPLETED;
			if(!validTransition)throw new Error('WITHDRAWAL_TRANSITION_INVALID');
			const reference=`FUNDING:${current.id}:WITHDRAWAL:${input.action}`;
			if(input.action==='COMPLETE'||input.action==='REVERSE'){
				const account=await ensureUserLedger(tx,current.userId,AccountMode.DEMO,current.currency);
				const clearing=await ensureSystemAccount(tx,`SYSTEM:DEMO:WITHDRAWAL:${current.currency}`,`Simulated withdrawal clearing ${current.currency}`,current.currency,AccountMode.DEMO);
				if(input.action==='COMPLETE'){
					if((await balance(tx,account.id)).lt(current.amount))throw new Error('WITHDRAWAL_FUNDS_UNAVAILABLE');
					await postDoubleEntry(tx,{reference,description:`Completed simulated withdrawal · ${input.note}`,debitAccountId:account.id,creditAccountId:clearing.id,amount:current.amount});
				}else{
					await postDoubleEntry(tx,{reference,description:`Reversed simulated withdrawal · ${input.note}`,debitAccountId:clearing.id,creditAccountId:account.id,amount:current.amount});
				}
			}
			const nextStatus=input.action==='PROCESS'?FundingStatus.PROCESSING:input.action==='COMPLETE'?FundingStatus.COMPLETED:input.action==='FAIL'?FundingStatus.FAILED:FundingStatus.REVERSED;
			const changed=await tx.fundingRequest.updateMany({where:{id:current.id,status:current.status},data:{status:nextStatus,adminNote:input.note,settlementReference:input.action==='COMPLETE'||input.action==='REVERSE'?reference:current.settlementReference,settledAt:input.action==='COMPLETE'?new Date():current.settledAt}});
			if(changed.count!==1)throw new Error('WITHDRAWAL_TRANSITION_INVALID');
			const updated=await tx.fundingRequest.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{
				actorId:admin.id,
				action:actionName,
				entity:'FUNDING',
				entityId:current.id,
				metadata:{accountMode:AccountMode.DEMO,simulated:true,oldStatus:current.status,newStatus:nextStatus,amount:current.amount.toString(),currency:current.currency,reference,note:input.note,idempotencyKey},
			}});
			const title=input.action==='PROCESS'?'Simulated withdrawal processing':input.action==='COMPLETE'?'Simulated withdrawal completed':input.action==='FAIL'?'Simulated withdrawal failed':'Simulated withdrawal reversed';
			const message=input.action==='PROCESS'?`Your simulated withdrawal of ${current.amount.toString()} ${current.currency} is being processed. The reserved balance has not yet been debited.`:input.action==='COMPLETE'?`Your simulated withdrawal of ${current.amount.toString()} ${current.currency} is complete. The simulated account ledger was debited. Reference: ${reference}. No external payment was sent.`:input.action==='FAIL'?`Your simulated withdrawal of ${current.amount.toString()} ${current.currency} failed. The reservation was released and no ledger debit was posted. Reason: ${input.note}`:`Your simulated withdrawal of ${current.amount.toString()} ${current.currency} was reversed and the amount was returned to the simulated ledger. Reference: ${reference}.`;
			await createNotification(tx,{userId:current.userId,type:NotificationType.WITHDRAWAL,title,message,dedupeKey:`${actionName}:${current.id}:${idempotencyKey}`,relatedEntity:'FUNDING',relatedId:current.id,actionUrl:`/wallet/transactions/${current.id}`});
			return {request:updated,replayed:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		const {receiptKey,...safeRequest}=result.request;
		return NextResponse.json({...safeRequest,replayed:result.replayed},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose a valid simulated withdrawal action and provide an audit reason.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='SIMULATED_WITHDRAWAL_REQUIRED')return NextResponse.json({error:'Only DEMO withdrawal requests can use the simulated execution workflow.'},{status:409});
		if(error instanceof Error&&error.message==='WITHDRAWAL_TRANSITION_INVALID')return NextResponse.json({error:'This withdrawal is not in a state that permits the requested transition.'},{status:409});
		if(error instanceof Error&&error.message==='WITHDRAWAL_FUNDS_UNAVAILABLE')return NextResponse.json({error:'Reserved funds are no longer available; no withdrawal debit was posted.'},{status:409});
		if(error&&typeof error==='object'&&'code' in error&&String(error.code)==='P2034')return NextResponse.json({error:'The withdrawal changed during this action. Retry with the same idempotency key.'},{status:409});
		console.error('Simulated withdrawal transition failed.',error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to update the simulated withdrawal.'},{status:503});
	}
}
