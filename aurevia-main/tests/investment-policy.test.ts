import {describe,expect,it} from 'vitest';
import {InvestmentStatus,Prisma} from '@prisma/client';
import {nextInvestmentStatus,simulatedInvestmentPayout,validateInvestmentSettlement} from '../lib/investment-policy';

describe('investment lifecycle policy',()=>{
 it('allows only explicit lifecycle transitions',()=>{
  expect(nextInvestmentStatus(InvestmentStatus.PENDING_APPROVAL,'approve')).toBe(InvestmentStatus.APPROVED);
  expect(nextInvestmentStatus(InvestmentStatus.APPROVED,'activate')).toBe(InvestmentStatus.ACTIVE);
  expect(nextInvestmentStatus(InvestmentStatus.ACTIVE,'complete')).toBe(InvestmentStatus.COMPLETED);
  expect(nextInvestmentStatus(InvestmentStatus.COMPLETED,'settle')).toBe(InvestmentStatus.SETTLED);
  expect(()=>nextInvestmentStatus(InvestmentStatus.ACTIVE,'settle')).toThrow('INVESTMENT_TRANSITION_NOT_ALLOWED');
 });

 it('requires a non-negative simulated payout for either account mode',()=>{
  expect(()=>validateInvestmentSettlement(undefined)).toThrow('SIMULATED_PAYOUT_REQUIRED');
  expect(()=>validateInvestmentSettlement(-1)).toThrow('SIMULATED_PAYOUT_REQUIRED');
  expect(()=>validateInvestmentSettlement(0)).not.toThrow();
  expect(()=>validateInvestmentSettlement(100)).not.toThrow();
 });

 it('calculates simulated target return with decimal precision',()=>{
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),new Prisma.Decimal('8')).toFixed(2)).toBe('1080.00');
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),new Prisma.Decimal('-100')).toFixed(2)).toBe('0.00');
  expect(simulatedInvestmentPayout(new Prisma.Decimal('1000'),null).toFixed(2)).toBe('1000.00');
 });
});