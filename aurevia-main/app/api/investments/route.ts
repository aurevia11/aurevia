import {NextResponse} from 'next/server';
import {AccountMode,InvestmentOpportunityStatus,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

const requestSchema=z.object({opportunityId:z.string().min(1),amount:z.number().positive().max(1_000_000_000)});
const requestKeyPattern=/^[a-zA-Z0-9_-]{12,128}$/;

function sameRequest(existing:{userId:string;opportunityId:string;accountMode:AccountMode;amount:Prisma.Decimal},userId:string,opportunityId:string,accountMode:AccountMode,amount:number){
 return existing.userId===userId&&existing.opportunityId===opportunityId&&existing.accountMode===accountMode&&existing.amount.equals(amount);
}

export async function GET(){
 try{
  const user=await requireUser();
  const modeFilter=user.accountMode===AccountMode.DEMO?{demoEligible:true}:{realEligible:true};
  const [opportunities,requests,account]=await Promise.all([
   db.investmentOpportunity.findMany({where:{status:InvestmentOpportunityStatus.AVAILABLE,...modeFilter},orderBy:{createdAt:'desc'}}),
   db.investmentRequest.findMany({where:{userId:user.id,accountMode:user.accountMode},include:{opportunity:{select:{title:true,category:true,assetSymbol:true,riskLevel:true,targetReturnPercent:true,durationDays:true}}},orderBy:{requestedAt:'desc'},take:100}),
   db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${user.accountMode}:USD`},select:{id:true}}),
  ]);
  return NextResponse.json(jsonSafe({accountMode:user.accountMode,availableBalance:account?await balance(db,account.id):new Prisma.Decimal(0),opportunities,requests}),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load investments.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503,headers:{'Cache-Control':'private, no-store'}});
 }
}

export async function POST(request:Request){
 try{
  const user=await requireUser();
  const input=requestSchema.parse(await request.json());
  const idempotencyKey=request.headers.get('Idempotency-Key')||'';
  if(!requestKeyPattern.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
  const result=await db.$transaction(async tx=>{
   const prior=await tx.investmentRequest.findUnique({where:{idempotencyKey}});
   if(prior){
    if(!sameRequest(prior,user.id,input.opportunityId,user.accountMode,input.amount))throw new Error('IDEMPOTENCY_KEY_REUSED');
    return {investment:prior,replay:true};
   }
   const opportunity=await tx.investmentOpportunity.findUnique({where:{id:input.opportunityId}});
   if(!opportunity||opportunity.status!==InvestmentOpportunityStatus.AVAILABLE)throw new Error('INVESTMENT_UNAVAILABLE');
   if(user.accountMode===AccountMode.DEMO&&!opportunity.demoEligible)throw new Error('INVESTMENT_MODE_UNAVAILABLE');
   if(user.accountMode===AccountMode.REAL&&!opportunity.realEligible)throw new Error('INVESTMENT_MODE_UNAVAILABLE');
   const amount=new Prisma.Decimal(input.amount);
   if(amount.lt(opportunity.minimumAmount)||(opportunity.maximumAmount&&amount.gt(opportunity.maximumAmount)))throw new Error('INVESTMENT_AMOUNT_OUT_OF_RANGE');
   if(user.accountMode===AccountMode.REAL){
    const profile=await tx.user.findUnique({where:{id:user.id},select:{kycStatus:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true},take:1}}});
    if(profile?.kycStatus!=='APPROVED'||!profile.kyc?.submittedAt||profile.kycDocuments.length===0)throw new Error('REAL_INVESTMENT_KYC_REQUIRED');
   }
    let status:InvestmentStatus=InvestmentStatus.PENDING_APPROVAL;
   let approvedAt:Date|undefined;
   if(user.accountMode===AccountMode.DEMO&&!opportunity.requiresApproval){status=InvestmentStatus.APPROVED;approvedAt=new Date();}
   const investment=await tx.investmentRequest.create({data:{userId:user.id,opportunityId:opportunity.id,accountMode:user.accountMode,amount,status,idempotencyKey,targetReturnPercent:opportunity.targetReturnPercent,durationDays:opportunity.durationDays,approvedAt}});
   if(user.accountMode===AccountMode.DEMO){
    const userAccount=await ensureUserLedger(tx,user.id,AccountMode.DEMO,'USD');
    const available=await balance(tx,userAccount.id);
    if(available.lt(amount))throw new Error('INSUFFICIENT_DEMO_BALANCE');
    const escrow=await ensureSystemAccount(tx,'SYSTEM:INVESTMENT_ESCROW:DEMO:USD','Demo investment escrow','USD',AccountMode.DEMO);
    await postDoubleEntry(tx,{reference:`INVESTMENT:${investment.id}:RESERVE`,description:`Reserve simulated funds for ${opportunity.title}`,debitAccountId:userAccount.id,creditAccountId:escrow.id,amount});
   }
   await tx.auditLog.create({data:{actorId:user.id,action:'INVESTMENT_SUBMITTED',entity:'INVESTMENT',entityId:investment.id,metadata:{opportunityId:opportunity.id,accountMode:user.accountMode,amount:amount.toString(),status,simulated:user.accountMode===AccountMode.DEMO}}});
   await createNotification(tx,{userId:user.id,type:NotificationType.SYSTEM,title:'Investment request submitted',message:user.accountMode===AccountMode.DEMO?'Your DEMO investment request is simulated; the requested virtual amount is reserved pending review.':'Your REAL investment request is pending administrator review. No funds were moved and submission does not confirm an external investment.',dedupeKey:`investment:${investment.id}:submitted`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/investments'});
   await notifyActiveAdmins(tx,{type:NotificationType.SYSTEM,title:'Investment request awaiting review',message:`A ${user.accountMode} investment request is awaiting administrator review.`,dedupeKey:`investment:${investment.id}:admin`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/admin/investments'});
   return {investment,replay:false};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  return NextResponse.json(jsonSafe(result.investment),{status:result.replay?200:201,headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Enter an amount within the opportunity limits.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='REAL_INVESTMENT_KYC_REQUIRED')return NextResponse.json({error:'Approved identity verification is required for REAL investment requests.'},{status:403});
  if(error instanceof Error&&['IDEMPOTENCY_KEY_REUSED','INVESTMENT_UNAVAILABLE','INVESTMENT_MODE_UNAVAILABLE'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  if(error instanceof Error&&['INVESTMENT_AMOUNT_OUT_OF_RANGE','INSUFFICIENT_DEMO_BALANCE'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:400});
  if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2002')return NextResponse.json({error:'This investment request was already received.'},{status:409});
  return NextResponse.json({error:'Unable to submit this investment request.'},{status:503});
 }
}