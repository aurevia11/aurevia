import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';

const manualBalanceSchema=z.object({
  accountMode:z.enum(['DEMO','REAL']),
  currency:z.string().trim().regex(/^[A-Za-z]{3,10}$/).default('USD'),
  amount:z.coerce.number().positive().max(100000000),
  type:z.enum(['CREDIT','DEBIT']),
  note:z.string().trim().max(300).optional(),
  settlementReference:z.string().trim().min(4).max(180).optional(),
}).refine(value=>value.accountMode!=='REAL'||(value.type==='CREDIT'&&!!value.settlementReference),{message:'REAL credits require a verified external settlement reference.'});

const schema=z.object({
  userId:z.string(),
  status:z.enum(['ACTIVE','FROZEN']).optional(),
  role:z.enum(['USER','ADMIN']).optional(),
  kycStatus:z.enum(['PENDING','APPROVED','REJECTED','NEEDS_CHANGES']).optional(),
  withdrawalEnabled:z.boolean().optional(),
  accountRestricted:z.boolean().optional(),
  restrictionReason:z.string().trim().max(500).optional(),
  reviewNote:z.string().trim().max(500).optional(),
  manualBalance:manualBalanceSchema.optional(),
});

export async function GET(){
  try{
    await requireAdmin();
    const users=await db.user.findMany({
      select:{id:true,email:true,name:true,country:true,phone:true,role:true,status:true,kycStatus:true,accountMode:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,createdAt:true,kyc:{select:{legalName:true,dob:true,address:true,idType:true,idNumber:true,submittedAt:true,reviewedAt:true,reviewNote:true}},kycDocuments:{select:{id:true,kind:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true,reviewedAt:true,reviewNote:true},orderBy:{uploadedAt:'desc'}}},
      orderBy:{createdAt:'desc'},
      take:200,
    });
    return NextResponse.json(users,{headers:{'Cache-Control':'private, no-store'}});
  }catch{return NextResponse.json({error:'Forbidden'},{status:403})}
}
export async function PATCH(req:Request){
  try{
    const admin=await requireAdmin();
    const input=schema.parse(await req.json());
    if(input.userId===admin.id&&(input.status==='FROZEN'||input.role==='USER'))throw new Error('CANNOT_DISABLE_CURRENT_ADMIN');
    const updated=await db.$transaction(async tx=>{
      const current=await tx.user.findUniqueOrThrow({where:{id:input.userId},select:{kycStatus:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true},take:1}}});
      if(input.manualBalance?.accountMode==='REAL'&&(current.kycStatus!=='APPROVED'||!current.kyc?.submittedAt||current.kycDocuments.length===0))throw new Error('REAL_KYC_REQUIRED');
      const kycChanged=input.kycStatus!==undefined&&input.kycStatus!==current.kycStatus;
      const restrictionChanged=(input.withdrawalEnabled!==undefined&&input.withdrawalEnabled!==current.withdrawalEnabled)||(input.accountRestricted!==undefined&&input.accountRestricted!==current.accountRestricted)||(input.restrictionReason!==undefined&&input.restrictionReason!==current.restrictionReason);
      if(input.kycStatus!==undefined&&!kycChanged)throw new Error('KYC_STATUS_UNCHANGED');
      if(input.kycStatus==='APPROVED'&&(!current.kyc?.submittedAt||!current.kycDocuments.length))throw new Error('APPROVED_IDENTITY_DOCUMENT_REQUIRED');
      const user=await tx.user.update({where:{id:input.userId},data:{status:input.status,role:input.role,kycStatus:input.kycStatus,withdrawalEnabled:input.withdrawalEnabled,accountRestricted:input.accountRestricted,...(input.accountRestricted===false?{restrictionReason:null}:input.restrictionReason!==undefined?{restrictionReason:input.restrictionReason||null}:{})},select:{id:true,email:true,name:true,role:true,status:true,kycStatus:true,accountMode:true,createdAt:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true}});
      if(kycChanged)await tx.kycProfile.updateMany({where:{userId:user.id},data:{reviewedAt:new Date(),reviewNote:input.reviewNote||null}});
      await tx.auditLog.create({data:{actorId:admin.id,action:kycChanged?`KYC_${input.kycStatus}`:restrictionChanged?'USER_ACCOUNT_RESTRICTION':'USER_UPDATE',entity:'USER',entityId:user.id,metadata:{...input,reviewNote:input.reviewNote||null}}});
      if(kycChanged){
        const status=input.kycStatus!;
        const title=status==='APPROVED'?'Identity profile approved by administrator':status==='REJECTED'?'Identity profile rejected by administrator':status==='NEEDS_CHANGES'?'Additional identity information requested':'Identity profile review updated';
        const message=`An administrator marked your identity profile ${status.toLowerCase().replaceAll('_',' ')}. This is not an external identity-provider, AML/sanctions, or regulatory verification.${input.reviewNote?` Admin note: ${input.reviewNote}`:''}`;
        await createNotification(tx,{userId:user.id,type:NotificationType.KYC,title,message,dedupeKey:`kyc:${user.id}:${status}:${user.createdAt.toISOString()}:${new Date().toISOString()}`,actionUrl:'/kyc'});
      }
      if(restrictionChanged)await createNotification(tx,{userId:user.id,type:NotificationType.SECURITY,title:'Account access updated',message:user.accountRestricted?`An administrator restricted account access.${user.restrictionReason?` Reason: ${user.restrictionReason}`:''}`:!user.withdrawalEnabled?'Withdrawals are currently disabled for your account.':'Account restrictions were updated by an administrator.',dedupeKey:`account-control:${user.id}:${Date.now()}`,actionUrl:'/tier'});
      if(input.manualBalance){
        const {accountMode,currency,amount,type,note,settlementReference}=input.manualBalance;
        const adjustmentId=randomUUID();
        const normalisedCurrency=currency.toUpperCase();
        const userAccount=await ensureUserLedger(tx,user.id,accountMode,normalisedCurrency);
        if(accountMode==='REAL'&&type==='CREDIT'){
          const previousCredit=await tx.auditLog.findFirst({where:{OR:[{action:'REAL_BALANCE_CREDIT',metadata:{path:['settlementReference'],equals:settlementReference}},{action:'FUNDING_APPROVED',entity:'FUNDING',metadata:{path:['transactionReference'],equals:settlementReference}}]}});
          if(previousCredit)throw new Error('REAL_SETTLEMENT_REFERENCE_REUSED');
        }
        const adminReserve=await ensureSystemAccount(tx,`SYSTEM:ADMIN:${accountMode}:${normalisedCurrency}`,`Admin ${accountMode} adjustment clearing`,normalisedCurrency,accountMode);
        if(type==='DEBIT'){
          const available=await balance(tx,userAccount.id);
          if(available.lt(amount))throw new Error('INSUFFICIENT_LEDGER_BALANCE');
          await postDoubleEntry(tx,{reference:`ADMIN_ADJUST_DEBIT:${user.id}:${adjustmentId}`,description:note||'Administrator DEMO balance adjustment',debitAccountId:userAccount.id,creditAccountId:adminReserve.id,amount});
        }else{
          await postDoubleEntry(tx,{reference:`ADMIN_ADJUST_CREDIT:${user.id}:${adjustmentId}`,description:note||'Administrator DEMO virtual balance credit',debitAccountId:adminReserve.id,creditAccountId:userAccount.id,amount});
        }
        const action=accountMode==='REAL'?'REAL_BALANCE_CREDIT':type==='CREDIT'?'USER_BALANCE_CREDIT':'USER_BALANCE_DEBIT';
        await tx.auditLog.create({data:{actorId:admin.id,action,entity:'LEDGER_ACCOUNT',entityId:userAccount.id,metadata:{userId:user.id,accountMode,currency:normalisedCurrency,amount:String(amount),note:note||null,settlementReference:accountMode==='REAL'?settlementReference:null}}});
        const description=`${normalisedCurrency} ${Number(amount).toLocaleString(undefined,{maximumFractionDigits:2})}`;
        const message=accountMode==='REAL'?`An administrator verified external settlement ${settlementReference} and credited ${description} to your REAL account.`:type==='CREDIT'?`An administrator added ${description} in virtual funds to your DEMO account. No real funds were transferred.`:`An administrator adjusted your DEMO virtual balance by ${description}. No real funds were transferred.`;
        await createNotification(tx,{userId:user.id,type:NotificationType.SYSTEM,title:accountMode==='REAL'?'REAL account credited':type==='CREDIT'?'DEMO virtual balance updated':'DEMO virtual balance adjusted',message,dedupeKey:`admin-adjust:${user.id}:${adjustmentId}`,actionUrl:'/wallet'});
      }
      return user;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    return NextResponse.json(updated);
  }catch(error){
    if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    if(error instanceof ZodError)return NextResponse.json({error:'Invalid review details.'},{status:400});
    if(error instanceof Error&&error.message==='KYC_STATUS_UNCHANGED')return NextResponse.json({error:'This verification status was already recorded.'},{status:409});
    if(error instanceof Error&&error.message==='APPROVED_IDENTITY_DOCUMENT_REQUIRED')return NextResponse.json({error:'Approve an identity document before approving account verification.'},{status:409});
    if(error instanceof Error&&error.message==='REAL_KYC_REQUIRED')return NextResponse.json({error:'Approved identity verification is required before crediting a REAL account.'},{status:409});
    if(error instanceof Error&&error.message==='INSUFFICIENT_LEDGER_BALANCE')return NextResponse.json({error:'The account does not have enough available balance for this adjustment.'},{status:409});
    if(error instanceof Error&&error.message==='REAL_SETTLEMENT_REFERENCE_REUSED')return NextResponse.json({error:'This external settlement reference has already been credited to this account.'},{status:409});
    return NextResponse.json({error:'Unable to update this account.'},{status:400});
  }
}
