import {NextResponse} from 'next/server';
import {AccountMode,FundingStatus,FundingType,InvestmentStatus,Prisma} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,initializeRealSimulatedAccount} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

const zero=()=>new Prisma.Decimal(0);
const activeInvestmentStatuses:Set<InvestmentStatus>=new Set([InvestmentStatus.PENDING_APPROVAL,InvestmentStatus.APPROVED,InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED]);

export async function GET(){
 try{
  const user=await requireUser();
  const mode=user.accountMode;
  if(mode===AccountMode.REAL)await db.$transaction(tx=>initializeRealSimulatedAccount(tx,user.id));
  const [account,positions,realizedAggregate,investments,settledInvestments,depositAggregate,withdrawalAggregate]=await Promise.all([
   db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${mode}:USD`},select:{id:true,startingBalance:true}}),
   db.position.findMany({where:{userId:user.id,accountMode:mode,status:'OPEN'},include:{instrument:true},orderBy:{openedAt:'asc'}}),
   db.position.aggregate({where:{userId:user.id,accountMode:mode},_sum:{realizedPnl:true}}),
   db.investmentRequest.findMany({where:{userId:user.id,accountMode:mode},include:{opportunity:{select:{title:true,category:true,riskLevel:true}}},orderBy:{requestedAt:'desc'}}),
   db.investmentRequest.findMany({where:{userId:user.id,accountMode:mode,status:InvestmentStatus.SETTLED},select:{amount:true,simulatedPayout:true}}),
   db.fundingRequest.aggregate({where:{userId:user.id,accountMode:mode,currency:'USD',type:FundingType.DEPOSIT,status:{in:[FundingStatus.APPROVED,FundingStatus.COMPLETED]}},_sum:{amount:true}}),
   db.fundingRequest.aggregate({where:{userId:user.id,accountMode:mode,currency:'USD',type:FundingType.WITHDRAWAL,status:{in:[FundingStatus.APPROVED,FundingStatus.COMPLETED]}},_sum:{amount:true}}),
  ]);
  const cashBalance=account?await balance(db,account.id):zero();
  let positionValue=zero();
  let unrealizedPnl=zero();
  const valuedPositions=positions.map(position=>{
   const currentPrice=position.instrument.price;
   const marketValue=currentPrice.mul(position.quantity);
   const direction=position.side==='BUY'?1:-1;
   const positionPnl=position.entryPrice.mul(-direction).plus(currentPrice.mul(direction)).mul(position.quantity);
   positionValue=positionValue.plus(marketValue);
   unrealizedPnl=unrealizedPnl.plus(positionPnl);
   return {...position,currentPrice,marketValue,unrealizedPnl:positionPnl};
  });
  const investedRequests=investments.filter(item=>activeInvestmentStatuses.has(item.status));
  const investmentValue=investedRequests.reduce((sum,item)=>sum.plus(item.amount),zero());
  const settledInvestmentPnl=settledInvestments.reduce((sum,item)=>sum.plus(item.simulatedPayout??0).minus(item.amount),zero());
  const realizedPnl=new Prisma.Decimal(realizedAggregate._sum.realizedPnl??0).plus(settledInvestmentPnl);
  const totalPnl=realizedPnl.plus(unrealizedPnl);
  const totalValue=cashBalance.plus(positionValue).plus(investmentValue);
  const netExternalDemoFunding=mode===AccountMode.DEMO?new Prisma.Decimal(depositAggregate._sum.amount??0).minus(withdrawalAggregate._sum.amount??0):zero();
  const startingBalance=account?.startingBalance??zero();
  const returnBasis=startingBalance.plus(netExternalDemoFunding);
  const returnPercent=returnBasis.gt(0)?totalPnl.div(returnBasis).mul(100):null;

  let dailyPnl:Prisma.Decimal|null=null;
  dailyPnl=zero();
  const dayStart=new Date();dayStart.setUTCHours(0,0,0,0);
  const instrumentIds=positions.map(position=>position.instrumentId);
  if(instrumentIds.length){
   const candles=await db.candle.findMany({where:{instrumentId:{in:instrumentIds},ts:{gte:dayStart}},orderBy:{ts:'asc'}});
   const firstToday=new Map<string,(typeof candles)[number]>();
   for(const candle of candles)if(!firstToday.has(candle.instrumentId))firstToday.set(candle.instrumentId,candle);
   for(const position of positions){
    const candle=firstToday.get(position.instrumentId);
    if(!candle){dailyPnl=null;break;}
    const sign=position.side==='BUY'?1:-1;
    dailyPnl=dailyPnl!.plus(position.instrument.price.minus(candle.open).mul(position.quantity).mul(sign));
   }
  }

  const interval=15*60_000;
  const snapshotBucket=new Date(Math.floor(Date.now()/interval)*interval);
  await db.portfolioSnapshot.upsert({where:{userId_accountMode_snapshotBucket:{userId:user.id,accountMode:mode,snapshotBucket}},create:{userId:user.id,accountMode:mode,snapshotBucket,cashBalance,positionValue,investmentValue,totalValue,realizedPnl,unrealizedPnl},update:{cashBalance,positionValue,investmentValue,totalValue,realizedPnl,unrealizedPnl}});
  const performance=await db.portfolioSnapshot.findMany({where:{userId:user.id,accountMode:mode},orderBy:{snapshotBucket:'desc'},take:96});
  const positionAllocations=new Map<string,Prisma.Decimal>();
  for(const position of valuedPositions){
   if(!position.marketValue)continue;
   const current=positionAllocations.get(position.instrument.symbol)||zero();
   positionAllocations.set(position.instrument.symbol,current.plus(position.marketValue));
  }
  const allocations=[...positionAllocations].map(([symbol,value])=>({symbol,value,percentage:positionValue.gt(0)?value.div(positionValue).mul(100):zero()}));
  const rankedPositions=valuedPositions.filter(position=>position.unrealizedPnl!==null).toSorted((left,right)=>Number(right.unrealizedPnl)-Number(left.unrealizedPnl));
  const response={accountMode:mode,currency:'USD',cashBalance,positionValue,investmentValue,totalValue,realizedPnl,unrealizedPnl,totalPnl,returnPercent,dailyPnl,positions:valuedPositions,investments,allocations,topGainers:rankedPositions.slice(0,3),topLosers:rankedPositions.slice(-3).reverse(),performance:performance.toReversed(),marketDataMode:'SIMULATED',externalValuationAvailable:false};
  return NextResponse.json(jsonSafe(response),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Portfolio data is temporarily unavailable.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503,headers:{'Cache-Control':'private, no-store'}});
 }
}