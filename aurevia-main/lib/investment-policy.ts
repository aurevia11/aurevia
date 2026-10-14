import {AccountMode,InvestmentStatus,Prisma} from '@prisma/client';

export type InvestmentAction='approve'|'reject'|'activate'|'pause'|'complete'|'cancel'|'settle';

const transitions:Record<InvestmentStatus,Partial<Record<InvestmentAction,InvestmentStatus>>>= {
 PENDING_APPROVAL:{approve:InvestmentStatus.APPROVED,reject:InvestmentStatus.REJECTED,cancel:InvestmentStatus.CANCELLED},
 APPROVED:{activate:InvestmentStatus.ACTIVE,cancel:InvestmentStatus.CANCELLED},
 ACTIVE:{pause:InvestmentStatus.PAUSED,complete:InvestmentStatus.COMPLETED,cancel:InvestmentStatus.CANCELLED},
 PAUSED:{activate:InvestmentStatus.ACTIVE,complete:InvestmentStatus.COMPLETED,cancel:InvestmentStatus.CANCELLED},
 COMPLETED:{settle:InvestmentStatus.SETTLED},
 REJECTED:{},
 CANCELLED:{},
 SETTLED:{},
};

export function nextInvestmentStatus(status:InvestmentStatus,action:InvestmentAction){
 const next=transitions[status][action];
 if(!next)throw new Error('INVESTMENT_TRANSITION_NOT_ALLOWED');
 return next;
}

export function validateInvestmentSettlement(payout:number|undefined){
 if(payout===undefined||!Number.isFinite(payout)||payout<0)throw new Error('SIMULATED_PAYOUT_REQUIRED');
}

export function simulatedInvestmentPayout(principal:Prisma.Decimal,targetReturnPercent:Prisma.Decimal|null){
 const target=targetReturnPercent??new Prisma.Decimal(0);
 return principal.mul(new Prisma.Decimal(100).plus(target)).div(100).toDecimalPlaces(10,Prisma.Decimal.ROUND_HALF_UP);
}