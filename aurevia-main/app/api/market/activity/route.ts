import {NextResponse} from 'next/server';
import {getServerSession} from 'next-auth';
import {AccountMode} from '@prisma/client';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

export async function GET(){
	const session=await getServerSession(authOptions);
	const userId=session?.user?.id;
	if(!userId)return NextResponse.json({activity:[],source:'sign in to view your private simulated executions'},{headers:{'Cache-Control':'private, no-store'}});
	const accountMode=session?.user?.accountMode===AccountMode.REAL?AccountMode.REAL:AccountMode.DEMO;
	const where={order:{accountMode,userId}};
	const executions=await db.execution.findMany({where,include:{order:{select:{side:true,status:true,accountMode:true,instrument:{select:{symbol:true}}}}},orderBy:{createdAt:'desc'},take:30});
	const activity=executions.map(execution=>({id:execution.id,instrument:execution.order.instrument.symbol,side:execution.order.side,quantity:execution.quantity,price:execution.price,timestamp:execution.createdAt,accountMode:execution.order.accountMode,status:execution.order.status}));
	return NextResponse.json(jsonSafe({activity,source:accountMode===AccountMode.DEMO?'simulated execution records':'your real-account records'}),{headers:{'Cache-Control':'private, no-store'}});
}