import {AccountMode,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';
import {simulatedInvestmentPayout} from '@/lib/investment-policy';

const batchSize=100;

export async function settleMaturedSimulatedInvestments(now=new Date()){
	const matured=await db.investmentRequest.findMany({where:{accountMode:{in:[AccountMode.DEMO,AccountMode.REAL]},status:InvestmentStatus.ACTIVE,maturesAt:{lte:now}},select:{id:true},orderBy:{maturesAt:'asc'},take:batchSize});
	let settledCount=0;
	for(const {id} of matured){
		let settled=false;
		for(let attempt=0;attempt<3;attempt++){
			try{
				settled=await db.$transaction(async tx=>{
			const current=await tx.investmentRequest.findUnique({where:{id},include:{opportunity:{select:{title:true}}}});
			if(!current||current.status!==InvestmentStatus.ACTIVE||!current.maturesAt||current.maturesAt>now)return false;
			const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
			if(!reservation)return false;
			const payout=simulatedInvestmentPayout(current.amount,current.targetReturnPercent);
			const settlementReference=`SIMULATED-AUTO-SETTLEMENT:${current.accountMode}:${current.id}`;
			const changed=await tx.investmentRequest.updateMany({where:{id:current.id,accountMode:current.accountMode,status:InvestmentStatus.ACTIVE,maturesAt:{lte:now}},data:{status:InvestmentStatus.SETTLED,completedAt:current.completedAt??now,settledAt:now,settlementReference,simulatedPayout:payout}});
			if(changed.count!==1)return false;

			const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${current.accountMode}:USD`,`${current.accountMode} simulated investment escrow`,'USD',current.accountMode);
			const userAccount=await ensureUserLedger(tx,current.userId,current.accountMode,'USD');
			const principal=payout.lt(current.amount)?payout:current.amount;
			if(principal.gt(0))await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:PAYOUT`,description:`Simulated principal and payout for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:userAccount.id,amount:principal});
			if(payout.gt(current.amount)){
				const returns=await ensureSystemAccount(tx,`SYSTEM:${current.accountMode}:INVESTMENT_RETURNS`,`${current.accountMode} simulated investment returns`,'USD',current.accountMode);
				await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_RETURN`,description:`Simulated investment return for ${current.opportunity.title}`,debitAccountId:returns.id,creditAccountId:userAccount.id,amount:payout.minus(current.amount)});
			}else if(current.amount.gt(payout)){
				const losses=await ensureSystemAccount(tx,`SYSTEM:${current.accountMode}:INVESTMENT_LOSSES`,`${current.accountMode} simulated investment losses`,'USD',current.accountMode);
				await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_LOSS`,description:`Simulated investment loss for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:losses.id,amount:current.amount.minus(payout)});
			}
			await tx.auditLog.create({data:{actorId:null,action:'SIMULATED_INVESTMENT_AUTO_SETTLED',entity:'INVESTMENT',entityId:current.id,metadata:{accountMode:current.accountMode,simulated:true,principal:current.amount.toString(),targetReturnPercent:current.targetReturnPercent?.toString()??null,simulatedPayout:payout.toString(),settlementReference}}});
			await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:`${current.accountMode} simulated investment matured`,message:`Your ${current.accountMode} simulated investment matured and a virtual payout of ${payout.toFixed(2)} USD was credited using its configured target return. This is not real investment profit.`,dedupeKey:`investment:${current.id}:auto-settled`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
			return true;
				},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
				break;
			}catch(error){
				const retryable=error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034';
				if(!retryable||attempt===2)throw error;
				await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
			}
		}
		if(settled)settledCount++;
	}
	return settledCount;
}