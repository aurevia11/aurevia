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
  idempotencyKey:z.string().uuid().optional(),
}).refine(value=>value.accountMode!=='REAL'||value.type==='CREDIT',{message:'REAL account adjustments only support configured credits.'});

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
        const {accountMode,currency,amount,type,note,idempotencyKey}=input.manualBalance;
        const adjustmentId=randomUUID();
        const normalisedCurrency=currency.toUpperCase();
        const userAccount=await ensureUserLedger(tx,user.id,accountMode,normalisedCurrency);
        const configuredRealCredit=accountMode==='REAL'&&type==='CREDIT';
        let fundingRequest:null|Awaited<ReturnType<typeof tx.fundingRequest.create>>=null;
        let creditAlreadyApplied=false;
        if(configuredRealCredit){
          if(!idempotencyKey)throw new Error('IDEMPOTENCY_KEY_REQUIRED');
          const previous=await tx.fundingRequest.findUnique({where:{idempotencyKey}});
          if(previous){
            if(previous.userId!==user.id||previous.type!=='DEPOSIT'||previous.accountMode!=='REAL'||previous.status!=='APPROVED'||previous.method!=='Admin configured simulated REAL deposit'||!previous.amount.equals(amount)||!previous.creditedAmount?.equals(amount))throw new Error('IDEMPOTENCY_KEY_REUSED');
            creditAlreadyApplied=true;
          }else{
            const reviewedAt=new Date();
            fundingRequest=await tx.fundingRequest.create({data:{userId:user.id,type:'DEPOSIT',method:'Admin configured simulated REAL deposit',amount:new Prisma.Decimal(amount),creditedAmount:new Prisma.Decimal(amount),currency:normalisedCurrency,status:'APPROVED',accountMode:'REAL',idempotencyKey,adminNote:note||'Configured simulated REAL deposit credit',reviewedAt}});
          }
        }
        if(!creditAlreadyApplied){
          const adminReserve=await ensureSystemAccount(tx,configuredRealCredit?`SYSTEM:CONFIGURED:REAL:${normalisedCurrency}`:`SYSTEM:ADMIN:${accountMode}:${normalisedCurrency}`,configuredRealCredit?'Configured simulated REAL balance':`Admin ${accountMode} adjustment clearing`,normalisedCurrency,accountMode);
          if(type==='DEBIT'){
            const available=await balance(tx,userAccount.id);
            if(available.lt(amount))throw new Error('INSUFFICIENT_LEDGER_BALANCE');
            await postDoubleEntry(tx,{reference:`ADMIN_ADJUST_DEBIT:${user.id}:${adjustmentId}`,description:note||'Administrator DEMO balance adjustment',debitAccountId:userAccount.id,creditAccountId:adminReserve.id,amount});
          }else{
            await postDoubleEntry(tx,{reference:fundingRequest?`FUNDING:${fundingRequest.id}:APPROVED`:`ADMIN_ADJUST_CREDIT:${user.id}:${adjustmentId}`,description:configuredRealCredit?'Configured simulated REAL deposit credit':note||'Administrator DEMO virtual balance credit',debitAccountId:adminReserve.id,creditAccountId:userAccount.id,amount});
          }
          const action=configuredRealCredit?'REAL_BALANCE_CREDIT':type==='CREDIT'?'USER_BALANCE_CREDIT':'USER_BALANCE_DEBIT';
          await tx.auditLog.create({data:{actorId:admin.id,action,entity:'LEDGER_ACCOUNT',entityId:userAccount.id,metadata:{userId:user.id,accountMode,currency:normalisedCurrency,amount:String(amount),note:note||null,simulated:configuredRealCredit,fundingRequestId:fundingRequest?.id??null,idempotencyKey:configuredRealCredit?idempotencyKey:null}}});
          if(fundingRequest)await tx.auditLog.create({data:{actorId:admin.id,action:'FUNDING_APPROVED',entity:'FUNDING',entityId:fundingRequest.id,metadata:{type:'DEPOSIT',accountMode:'REAL',currency:normalisedCurrency,requestedAmount:String(amount),creditedAmount:String(amount),simulated:true,source:'ADMIN_CONFIGURED_REAL_CREDIT'}}});
          const description=`${normalisedCurrency} ${Number(amount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
          const message=configuredRealCredit?`An administrator credited ${description} to your simulated/configured REAL balance. This is an internal ledger entry; no payment was processed and no money moved.`:type==='CREDIT'?`An administrator added ${description} in virtual funds to your DEMO account. No real funds were transferred.`:`An administrator adjusted your DEMO virtual balance by ${description}. No real funds were transferred.`;
          await createNotification(tx,{userId:user.id,type:configuredRealCredit?NotificationType.DEPOSIT:NotificationType.SYSTEM,title:configuredRealCredit?'Simulated REAL deposit credited':type==='CREDIT'?'DEMO virtual balance updated':'DEMO virtual balance adjusted',message,dedupeKey:fundingRequest?`funding:${fundingRequest.id}:approved`:`admin-adjust:${user.id}:${adjustmentId}`,relatedEntity:fundingRequest?'FUNDING':undefined,relatedId:fundingRequest?.id,actionUrl:fundingRequest?`/wallet/transactions/${fundingRequest.id}`:'/wallet'});
        }
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
    if(error instanceof Error&&['IDEMPOTENCY_KEY_REQUIRED','IDEMPOTENCY_KEY_REUSED'].includes(error.message))return NextResponse.json({error:error.message==='IDEMPOTENCY_KEY_REQUIRED'?'A unique credit request key is required.':'This credit request key has already been used for another adjustment.'},{status:409});
    return NextResponse.json({error:'Unable to update this account.'},{status:400});
  }
}
