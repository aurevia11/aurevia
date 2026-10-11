import {AccountMode,Prisma,PrismaClient,EntryType} from '@prisma/client';
const D=Prisma.Decimal;type Tx=PrismaClient|Prisma.TransactionClient;
export async function balance(tx:Tx,accountId:string){const rows=await tx.ledgerEntry.groupBy({by:['type'],where:{accountId},_sum:{amount:true}});return rows.reduce((n,r)=>r.type===EntryType.CREDIT?n.plus(r._sum.amount??0):n.minus(r._sum.amount??0),new D(0));}
export async function postDoubleEntry(tx:Tx,args:{reference:string;description:string;debitAccountId:string;creditAccountId:string;amount:Prisma.Decimal|string|number}){const amount=new D(args.amount);if(amount.lte(0))throw new Error('INVALID_AMOUNT');if(args.debitAccountId===args.creditAccountId)throw new Error('SAME_LEDGER_ACCOUNT');await tx.ledgerTransaction.create({data:{reference:args.reference,description:args.description,entries:{create:[{accountId:args.debitAccountId,type:EntryType.DEBIT,amount},{accountId:args.creditAccountId,type:EntryType.CREDIT,amount}]}}});}
export async function ensureUserLedger(tx:Tx,userId:string,accountMode:AccountMode=AccountMode.DEMO,currency='USD'){const normalizedCurrency=currency.toUpperCase();const code=`USER:${userId}:${accountMode}:${normalizedCurrency}`;return tx.ledgerAccount.upsert({where:{code},update:{},create:{userId,accountMode,code,name:`${accountMode} account ${userId} ${normalizedCurrency}`,currency:normalizedCurrency}})}
export async function ensureSystemAccount(tx:Tx,code:string,name:string,currency='USD',accountMode:AccountMode=AccountMode.DEMO){return tx.ledgerAccount.upsert({where:{code},update:{},create:{code,name,currency:currency.toUpperCase(),accountMode}})}
export const DEMO_STARTING_BALANCE=new D('5000.00');
export async function initializeDemoAccount(tx:Tx,userId:string){
 const account=await ensureUserLedger(tx,userId,AccountMode.DEMO,'USD');
 const reference=`DEMO:STARTING_BALANCE:${userId}`;
 const existing=await tx.ledgerTransaction.findUnique({where:{reference},select:{id:true}});
 if(existing)return false;
 if(await tx.ledgerEntry.count({where:{accountId:account.id}})>0)return false;
 const capital=await ensureSystemAccount(tx,'SYSTEM:DEMO:INITIAL_CAPITAL','Demo virtual capital','USD',AccountMode.DEMO);
 await postDoubleEntry(tx,{reference,description:'Initial simulated demo-account balance',debitAccountId:capital.id,creditAccountId:account.id,amount:DEMO_STARTING_BALANCE});
 await tx.auditLog.create({data:{actorId:userId,action:'DEMO_ACCOUNT_INITIALIZED',entity:'LEDGER_ACCOUNT',entityId:account.id,metadata:{currency:'USD',amount:DEMO_STARTING_BALANCE.toFixed(2),simulated:true}}});
 return true;
}
export async function assertTransactionBalanced(tx:Tx,transactionId:string){const rows=await tx.ledgerEntry.findMany({where:{transactionId}});const debit=rows.filter(x=>x.type===EntryType.DEBIT).reduce((n,x)=>n.plus(x.amount),new D(0));const credit=rows.filter(x=>x.type===EntryType.CREDIT).reduce((n,x)=>n.plus(x.amount),new D(0));if(!debit.eq(credit))throw new Error('UNBALANCED_LEDGER_TRANSACTION');return {debit,credit};}
