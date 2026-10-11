import {NextResponse} from 'next/server';
import {AccountMode,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {closeDemoPositionTx} from '@/lib/orders';
import {jsonSafe} from '@/lib/serializers';

const closeSchema=z.object({positionId:z.string().min(1)});

export async function GET(){
 try{
  const user=await requireUser();
  const positions=await db.position.findMany({where:{userId:user.id,accountMode:user.accountMode,status:'OPEN'},include:{instrument:true},orderBy:{openedAt:'desc'}});
  return NextResponse.json(jsonSafe(positions.map(position=>{
   const currentPrice=position.instrument.price;
   const marketValue=currentPrice.mul(position.quantity);
   const direction=position.side==='BUY'?1:-1;
   const unrealizedPnl=position.entryPrice.mul(-direction).plus(currentPrice.mul(direction)).mul(position.quantity);
   return {...position,currentPrice,marketValue,unrealizedPnl};
  })),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load positions.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503});
 }
}

export async function POST(request:Request){
 try{
  const user=await requireUser();
  if(user.accountMode!==AccountMode.DEMO)return NextResponse.json({error:'REAL_EXECUTION_UNAVAILABLE'},{status:409});
  const {positionId}=closeSchema.parse(await request.json());
  const closed=await db.$transaction(tx=>closeDemoPositionTx(tx,user.id,positionId),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  return NextResponse.json(jsonSafe(closed));
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Invalid position.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='REAL_EXECUTION_UNAVAILABLE')return NextResponse.json({error:error.message},{status:409});
  if(error instanceof Error&&error.message==='POSITION_NOT_FOUND')return NextResponse.json({error:'Open demo position not found.'},{status:404});
  return NextResponse.json({error:error instanceof Error?error.message:'Close failed'},{status:400});
 }
}
