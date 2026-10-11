import {describe,expect,it} from 'vitest';
import {AccountMode,KycStatus} from '@prisma/client';
import {DEMO_STARTING_BALANCE} from '../lib/ledger';
import {getAccountTier,validateWithdrawal,verifyKycState} from '../lib/production-policy';

describe('production account policy',()=>{
  it('starts every demo account with exactly 5,000 simulated USD',()=>{
    expect(DEMO_STARTING_BALANCE.toFixed(2)).toBe('5000.00');
  });

  it('keeps demo and real account states isolated',()=>{
    expect(getAccountTier({accountMode:AccountMode.DEMO,kycStatus:KycStatus.APPROVED,verificationDocuments:0}).label).toBe('TIER 1');
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.PENDING,verificationDocuments:0,verificationSubmitted:true}).label).toBe('TIER 2');
    const verified=getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1,verificationSubmitted:true});
    expect(verified.label).toBe('TIER 3');
    expect(verified.eligibleForRealTrading).toBe(false);
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1}).label).toBe('TIER 2');
  });

  it('honors an administrator-approved tier without enabling real trading',()=>{
    const approved=getAccountTier({accountMode:AccountMode.DEMO,kycStatus:KycStatus.PENDING,verificationDocuments:0,approvedTier:2});
    expect(approved.label).toBe('TIER 2');
    expect(approved.eligibleForRealTrading).toBe(false);
    expect(approved.verified).toBe(false);
  });

  it('rejects withdrawal when disabled or account restrictions apply',()=>{
    expect(()=>validateWithdrawal({balance:'100',pending:'10',amount:'101',withdrawalEnabled:true,kycStatus:KycStatus.APPROVED})).toThrow('INSUFFICIENT_BALANCE');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:false,kycStatus:KycStatus.APPROVED})).toThrow('WITHDRAWAL_DISABLED');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:true,accountRestricted:true,kycStatus:KycStatus.APPROVED})).toThrow('ACCOUNT_RESTRICTED');
  });

  it('only treats an approved real-account KYC state as verified',()=>{
    expect(verifyKycState(KycStatus.APPROVED)).toBe(true);
    expect(verifyKycState(KycStatus.PENDING)).toBe(false);
    expect(verifyKycState(KycStatus.REJECTED)).toBe(false);
  });
});
