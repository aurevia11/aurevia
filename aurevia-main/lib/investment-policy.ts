import {AccountMode,InvestmentStatus} from '@prisma/client';

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

export function validateInvestmentSettlement(accountMode:AccountMode,reference:string|undefined,payout:number|undefined){
 if(accountMode===AccountMode.REAL){
  if(!reference?.trim())throw new Error('EXTERNAL_SETTLEMENT_REFERENCE_REQUIRED');
  if(payout!==undefined)throw new Error('REAL_PAYOUT_NOT_SUPPORTED');
  return;
 }
 if(payout===undefined||!Number.isFinite(payout)||payout<0)throw new Error('SIMULATED_PAYOUT_REQUIRED');
}