import {AccountMode,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';
import {simulatedInvestmentPayout} from '@/lib/investment-policy';

const batchSize=100;

export async function settleMaturedDemoInvestments(now=new Date()){
	const matured=await db.investmentRequest.findMany({where:{accountMode:AccountMode.DEMO,status:InvestmentStatus.ACTIVE,maturesAt:{lte:now}},select:{id:true},orderBy:{maturesAt:'asc'},take:batchSize});
	let settledCount=0;
	for(const {id} of matured){
		const settled=await db.$transaction(async tx=>{
			const current=await tx.investmentRequest.findUnique({where:{id},include:{opportunity:{select:{title:true}}}});
			if(!current||current.accountMode!==AccountMode.DEMO||current.status!==InvestmentStatus.ACTIVE||!current.maturesAt||current.maturesAt>now)return false;
			const payout=simulatedInvestmentPayout(current.amount,current.targetReturnPercent);
			const settlementReference=`DEMO-AUTO-SETTLEMENT:${current.id}`;
			const changed=await tx.investmentRequest.updateMany({where:{id:current.id,accountMode:AccountMode.DEMO,status:InvestmentStatus.ACTIVE,maturesAt:{lte:now}},data:{status:InvestmentStatus.SETTLED,completedAt:current.completedAt??now,settledAt:now,settlementReference,simulatedPayout:payout}});
			if(changed.count!==1)return false;

			const escrow=await ensureSystemAccount(tx,'SYSTEM:INVESTMENT_ESCROW:DEMO:USD','Demo investment escrow','USD',AccountMode.DEMO);
			const userAccount=await ensureUserLedger(tx,current.userId,AccountMode.DEMO,'USD');
			const principal=payout.lt(current.amount)?payout:current.amount;
			if(principal.gt(0))await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:PAYOUT`,description:`Simulated principal and payout for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:userAccount.id,amount:principal});
			if(payout.gt(current.amount)){
				const returns=await ensureSystemAccount(tx,'SYSTEM:DEMO:INVESTMENT_RETURNS','Demo simulated investment returns','USD',AccountMode.DEMO);
				await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_RETURN`,description:`Simulated investment return for ${current.opportunity.title}`,debitAccountId:returns.id,creditAccountId:userAccount.id,amount:payout.minus(current.amount)});
			}else if(current.amount.gt(payout)){
				const losses=await ensureSystemAccount(tx,'SYSTEM:DEMO:INVESTMENT_LOSSES','Demo simulated investment losses','USD',AccountMode.DEMO);
				await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_LOSS`,description:`Simulated investment loss for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:losses.id,amount:current.amount.minus(payout)});
			}
			await tx.auditLog.create({data:{actorId:null,action:'DEMO_INVESTMENT_AUTO_SETTLED',entity:'INVESTMENT',entityId:current.id,metadata:{accountMode:AccountMode.DEMO,principal:current.amount.toString(),targetReturnPercent:current.targetReturnPercent?.toString()??null,simulatedPayout:payout.toString(),settlementReference}}});
			await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:'DEMO investment matured',message:`Your DEMO investment matured and a simulated payout of ${payout.toFixed(2)} USD was credited using its configured target return. This is a virtual result, not real investment profit.`,dedupeKey:`investment:${current.id}:auto-settled`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
			return true;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		if(settled)settledCount++;
	}
	return settledCount;
}