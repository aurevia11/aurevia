import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {AccountMode,InvestmentOpportunityStatus,InvestmentRisk,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry} from '@/lib/ledger';
import {InvestmentAction,nextInvestmentStatus,validateInvestmentSettlement} from '@/lib/investment-policy';
import {createNotification} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

const opportunityFields=z.object({
 title:z.string().trim().min(3).max(120),
 category:z.string().trim().min(2).max(80),
 description:z.string().trim().min(10).max(3000),
 assetSymbol:z.string().trim().max(30).optional().nullable(),
 minimumAmount:z.number().positive().max(1_000_000_000),
 maximumAmount:z.number().positive().max(1_000_000_000).optional().nullable(),
 targetReturnPercent:z.number().min(-100).max(1000).optional().nullable(),
 durationDays:z.number().int().min(1).max(3650),
 startsAt:z.coerce.date().optional().nullable(),
 maturesAt:z.coerce.date().optional().nullable(),
 riskLevel:z.nativeEnum(InvestmentRisk),
 status:z.nativeEnum(InvestmentOpportunityStatus).default(InvestmentOpportunityStatus.DRAFT),
 demoEligible:z.boolean().default(true),
 realEligible:z.boolean().default(true),
 requiresApproval:z.boolean().default(true),
 targetPrice:z.number().positive().optional().nullable(),
 stopPrice:z.number().positive().optional().nullable(),
});
const opportunitySchema=opportunityFields.superRefine((value,context)=>{
 if(value.maximumAmount!==undefined&&value.maximumAmount!==null&&value.maximumAmount<value.minimumAmount)context.addIssue({code:z.ZodIssueCode.custom,path:['maximumAmount'],message:'Maximum must be at least minimum.'});
 if(value.startsAt&&value.maturesAt&&value.maturesAt<=value.startsAt)context.addIssue({code:z.ZodIssueCode.custom,path:['maturesAt'],message:'Maturity must follow the start date.'});
});

const updateOpportunitySchema=opportunityFields.partial().extend({action:z.literal('update-opportunity'),id:z.string().min(1)}).superRefine((value,context)=>{
 if(value.minimumAmount!==undefined&&value.maximumAmount!==undefined&&value.maximumAmount!==null&&value.maximumAmount<value.minimumAmount)context.addIssue({code:z.ZodIssueCode.custom,path:['maximumAmount'],message:'Maximum must be at least minimum.'});
 if(value.startsAt&&value.maturesAt&&value.maturesAt<=value.startsAt)context.addIssue({code:z.ZodIssueCode.custom,path:['maturesAt'],message:'Maturity must follow the start date.'});
});
const lifecycleSchema=z.object({
 action:z.enum(['approve','reject','activate','pause','complete','cancel','settle']),
 requestId:z.string().min(1),
 note:z.string().trim().max(500).optional(),
 simulatedPayout:z.number().min(0).max(1_000_000_000).optional(),
});

export async function GET(){
 try{
  await requireAdmin();
  const [opportunities,requests]=await Promise.all([
   db.investmentOpportunity.findMany({include:{_count:{select:{requests:true}}},orderBy:{createdAt:'desc'}}),
   db.investmentRequest.findMany({include:{user:{select:{id:true,email:true,name:true}},opportunity:{select:{title:true,category:true,riskLevel:true,durationDays:true}}},orderBy:{requestedAt:'desc'},take:500}),
  ]);
  return NextResponse.json(jsonSafe({opportunities,requests}),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
  return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
 }
}

export async function POST(request:Request){
 try{
  const admin=await requireAdmin();
  const input=opportunitySchema.parse(await request.json());
  const opportunity=await db.$transaction(async tx=>{
   const created=await tx.investmentOpportunity.create({data:{...input,createdById:admin.id}});
    await tx.auditLog.create({data:{actorId:admin.id,action:'INVESTMENT_OPPORTUNITY_CREATED',entity:'INVESTMENT_OPPORTUNITY',entityId:created.id,metadata:{newState:{title:created.title,category:created.category,assetSymbol:created.assetSymbol,minimumAmount:created.minimumAmount.toString(),maximumAmount:created.maximumAmount?.toString()??null,targetReturnPercent:created.targetReturnPercent?.toString()??null,durationDays:created.durationDays,startsAt:created.startsAt?.toISOString()??null,maturesAt:created.maturesAt?.toISOString()??null,riskLevel:created.riskLevel,status:created.status,demoEligible:created.demoEligible,realEligible:created.realEligible,requiresApproval:created.requiresApproval,targetPrice:created.targetPrice?.toString()??null,stopPrice:created.stopPrice?.toString()??null}}}});
   return created;
  });
  return NextResponse.json(jsonSafe(opportunity),{status:201});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Check the investment terms, amounts, dates, and eligibility.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
  return NextResponse.json({error:'Unable to create the investment opportunity.'},{status:400});
 }
}

export async function PATCH(request:Request){
 try{
  const admin=await requireAdmin();
  const body=await request.json() as {action?:string};
  if(body.action==='update-opportunity'){
   const input=updateOpportunitySchema.parse(body);
   const opportunity=await db.$transaction(async tx=>{
    const current=await tx.investmentOpportunity.findUnique({where:{id:input.id}});
    if(!current)throw new Error('INVESTMENT_OPPORTUNITY_NOT_FOUND');
    const minimum=input.minimumAmount??Number(current.minimumAmount);
    const maximum=input.maximumAmount===undefined?current.maximumAmount?.toNumber()??null:input.maximumAmount;
    if(maximum!==null&&maximum<minimum)throw new Error('INVALID_INVESTMENT_RANGE');
    const startsAt=input.startsAt===undefined?current.startsAt:input.startsAt;
    const maturesAt=input.maturesAt===undefined?current.maturesAt:input.maturesAt;
    if(startsAt&&maturesAt&&maturesAt<=startsAt)throw new Error('INVALID_INVESTMENT_DATES');
    const {action:_,id,...data}=input;
    const updated=await tx.investmentOpportunity.update({where:{id},data});
    await tx.auditLog.create({data:{actorId:admin.id,action:'INVESTMENT_OPPORTUNITY_UPDATED',entity:'INVESTMENT_OPPORTUNITY',entityId:id,metadata:{oldState:{title:current.title,category:current.category,assetSymbol:current.assetSymbol,minimumAmount:current.minimumAmount.toString(),maximumAmount:current.maximumAmount?.toString()??null,targetReturnPercent:current.targetReturnPercent?.toString()??null,durationDays:current.durationDays,startsAt:current.startsAt?.toISOString()??null,maturesAt:current.maturesAt?.toISOString()??null,riskLevel:current.riskLevel,status:current.status,demoEligible:current.demoEligible,realEligible:current.realEligible,requiresApproval:current.requiresApproval,targetPrice:current.targetPrice?.toString()??null,stopPrice:current.stopPrice?.toString()??null},newState:{title:updated.title,category:updated.category,assetSymbol:updated.assetSymbol,minimumAmount:updated.minimumAmount.toString(),maximumAmount:updated.maximumAmount?.toString()??null,targetReturnPercent:updated.targetReturnPercent?.toString()??null,durationDays:updated.durationDays,startsAt:updated.startsAt?.toISOString()??null,maturesAt:updated.maturesAt?.toISOString()??null,riskLevel:updated.riskLevel,status:updated.status,demoEligible:updated.demoEligible,realEligible:updated.realEligible,requiresApproval:updated.requiresApproval,targetPrice:updated.targetPrice?.toString()??null,stopPrice:updated.stopPrice?.toString()??null}}}});
    return updated;
   });
   return NextResponse.json(jsonSafe(opportunity),{headers:{'Cache-Control':'private, no-store'}});
  }

  const input=lifecycleSchema.parse(body);
  const result=await db.$transaction(async tx=>{
   const current=await tx.investmentRequest.findUnique({where:{id:input.requestId},include:{opportunity:true}});
   if(!current)throw new Error('INVESTMENT_REQUEST_NOT_FOUND');
   const action=input.action as InvestmentAction;
   const nextStatus=nextInvestmentStatus(current.status,action);
   if(action==='activate'){
    if(current.opportunity.startsAt&&current.opportunity.startsAt>new Date())throw new Error('INVESTMENT_NOT_STARTED');
    if(current.opportunity.maturesAt&&current.opportunity.maturesAt<=new Date())throw new Error('INVESTMENT_OPPORTUNITY_MATURED');
   }
   let settlementReference:string|undefined;
   if(action==='settle'){
    validateInvestmentSettlement(input.simulatedPayout);
    settlementReference=`SIMULATED-SETTLEMENT:${current.accountMode}:${current.id}`;
   }
   const now=new Date();
   const updateData:Prisma.InvestmentRequestUpdateManyMutationInput={status:nextStatus,adminNote:input.note??current.adminNote};
   if(action==='approve')updateData.approvedAt=now;
   if(action==='activate'){
    updateData.activatedAt=current.activatedAt??now;
    updateData.maturesAt=current.maturesAt??current.opportunity.maturesAt??new Date(now.getTime()+current.durationDays*86_400_000);
   }
   if(action==='complete')updateData.completedAt=now;
   if(action==='settle'){
    updateData.settledAt=now;
    updateData.settlementReference=settlementReference;
    updateData.simulatedPayout=new Prisma.Decimal(input.simulatedPayout!);
   }
   const changed=await tx.investmentRequest.updateMany({where:{id:current.id,status:current.status},data:updateData});
   if(changed.count!==1)throw new Error('INVESTMENT_STATE_CHANGED');

   if(action==='reject'||action==='cancel'){
    const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
    if(reservation){
     const userAccount=await ensureUserLedger(tx,current.userId,current.accountMode,'USD');
     const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${current.accountMode}:USD`,`${current.accountMode} simulated investment escrow`,'USD',current.accountMode);
     await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:REFUND`,description:`Return simulated investment funds for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:userAccount.id,amount:current.amount});
    }
   }
   if(action==='settle'){
    const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
    if(!reservation)throw new Error('SIMULATED_INVESTMENT_RESERVATION_MISSING');
    const payout=new Prisma.Decimal(input.simulatedPayout!);
    const principal=payout.lt(current.amount)?payout:current.amount;
    const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${current.accountMode}:USD`,`${current.accountMode} simulated investment escrow`,'USD',current.accountMode);
    const userAccount=await ensureUserLedger(tx,current.userId,current.accountMode,'USD');
    if(principal.gt(0))await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:PAYOUT`,description:`Simulated principal and payout for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:userAccount.id,amount:principal});
    if(payout.gt(current.amount)){
     const returns=await ensureSystemAccount(tx,`SYSTEM:${current.accountMode}:INVESTMENT_RETURNS`,`${current.accountMode} simulated investment returns`,'USD',current.accountMode);
     await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_RETURN`,description:`Simulated investment return for ${current.opportunity.title}`,debitAccountId:returns.id,creditAccountId:userAccount.id,amount:payout.minus(current.amount)});
    }else if(current.amount.gt(payout)){
     const losses=await ensureSystemAccount(tx,`SYSTEM:${current.accountMode}:INVESTMENT_LOSSES`,`${current.accountMode} simulated investment losses`,'USD',current.accountMode);
     await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:SIMULATED_LOSS`,description:`Simulated investment loss for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:losses.id,amount:current.amount.minus(payout)});
    }
   }
   const updated=await tx.investmentRequest.findUniqueOrThrow({where:{id:current.id}});
   await tx.auditLog.create({data:{actorId:admin.id,action:`INVESTMENT_${nextStatus}`,entity:'INVESTMENT',entityId:current.id,metadata:{oldState:current.status,newState:nextStatus,accountMode:current.accountMode,simulated:true,amount:current.amount.toString(),externalExecutionReference:null,settlementReference:settlementReference||null,simulatedPayout:action==='settle'?String(input.simulatedPayout):null,note:input.note||null}}});
   const statusText=nextStatus.toLowerCase().replaceAll('_',' ');
   const message=`Your ${current.accountMode} investment is ${statusText}. This is simulated activity; any payout is a virtual ledger result, not an external investment or return.`;
   await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:`Investment ${statusText}`,message,dedupeKey:`investment:${current.id}:${nextStatus}:${updated.updatedAt.toISOString()}`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
   return updated;
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  return NextResponse.json(jsonSafe(result),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Invalid opportunity or investment action.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    const conflicts=['INVESTMENT_TRANSITION_NOT_ALLOWED','INVESTMENT_STATE_CHANGED','INVESTMENT_NOT_STARTED','INVESTMENT_OPPORTUNITY_MATURED','SIMULATED_INVESTMENT_RESERVATION_MISSING'];
  if(error instanceof Error&&conflicts.includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  if(error instanceof Error&&['INVESTMENT_OPPORTUNITY_NOT_FOUND','INVESTMENT_REQUEST_NOT_FOUND'].includes(error.message))return NextResponse.json({error:'Investment record not found.'},{status:404});
  if(error instanceof Error&&['INVALID_INVESTMENT_RANGE','INVALID_INVESTMENT_DATES','SIMULATED_PAYOUT_REQUIRED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:400});
  return NextResponse.json({error:'Unable to update the investment record.'},{status:400});
 }
}