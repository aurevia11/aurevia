import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';

const schema=z.object({id:z.string().min(1),settlementReference:z.string().trim().min(3).max(180),note:z.string().trim().max(500).optional()});

export async function POST(req:Request){
	try{
		const admin=await requireAdmin();
		const input=schema.parse(await req.json());
		await db.auditLog.create({data:{actorId:admin.id,action:'REAL_WITHDRAWAL_SETTLEMENT_BLOCKED',entity:'FUNDING',entityId:input.id,metadata:{accountMode:AccountMode.REAL,reason:'PAYOUT_PROVIDER_UNAVAILABLE'}}});
		return NextResponse.json({error:'REAL_WITHDRAWAL_PROVIDER_UNAVAILABLE'},{status:503});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid settlement reference and note.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		return NextResponse.json({error:'Unable to record withdrawal settlement.'},{status:500});
	}
}
