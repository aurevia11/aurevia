import {describe,expect,it} from 'vitest';
import {AccountMode,InvestmentStatus} from '@prisma/client';
import {nextInvestmentStatus,validateInvestmentSettlement} from '../lib/investment-policy';

describe('investment lifecycle policy',()=>{
 it('allows only explicit lifecycle transitions',()=>{
  expect(nextInvestmentStatus(InvestmentStatus.PENDING_APPROVAL,'approve')).toBe(InvestmentStatus.APPROVED);
  expect(nextInvestmentStatus(InvestmentStatus.APPROVED,'activate')).toBe(InvestmentStatus.ACTIVE);
  expect(nextInvestmentStatus(InvestmentStatus.ACTIVE,'complete')).toBe(InvestmentStatus.COMPLETED);
  expect(nextInvestmentStatus(InvestmentStatus.COMPLETED,'settle')).toBe(InvestmentStatus.SETTLED);
  expect(()=>nextInvestmentStatus(InvestmentStatus.ACTIVE,'settle')).toThrow('INVESTMENT_TRANSITION_NOT_ALLOWED');
 });

 it('requires external references for REAL settlement and simulated payouts only for DEMO',()=>{
  expect(()=>validateInvestmentSettlement(AccountMode.REAL,undefined,undefined)).toThrow('EXTERNAL_SETTLEMENT_REFERENCE_REQUIRED');
  expect(()=>validateInvestmentSettlement(AccountMode.REAL,'external-ref',100)).toThrow('REAL_PAYOUT_NOT_SUPPORTED');
  expect(()=>validateInvestmentSettlement(AccountMode.REAL,'external-ref',undefined)).not.toThrow();
  expect(()=>validateInvestmentSettlement(AccountMode.DEMO,undefined,undefined)).toThrow('SIMULATED_PAYOUT_REQUIRED');
  expect(()=>validateInvestmentSettlement(AccountMode.DEMO,undefined,0)).not.toThrow();
 });
});