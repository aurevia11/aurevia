import {describe,expect,it} from 'vitest';
import {AccountMode,InvestmentStatus,Prisma} from '@prisma/client';
import {nextInvestmentStatus,simulatedInvestmentPayout,validateInvestmentSettlement} from '../lib/investment-policy';

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

 it('calculates simulated target return with decimal precision',()=>{
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),new Prisma.Decimal('8')).toFixed(2)).toBe('1080.00');
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),new Prisma.Decimal('-100')).toFixed(2)).toBe('0.00');
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),null).toFixed(2)).toBe('1000.00');
 });
});