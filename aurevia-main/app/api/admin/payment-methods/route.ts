import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

const methodSchema=z.object({
	name:z.string().trim().min(2).max(80),
	enabled:z.boolean(),
	demoOnly:z.boolean(),
	depositEnabled:z.boolean(),
	withdrawalEnabled:z.boolean(),
	requiresNetwork:z.boolean(),
	currencies:z.array(z.string().trim().regex(/^[A-Za-z]{3,10}$/)).min(1).max(20),
	destination:z.string().trim().max(500).nullable(),
	instructions:z.string().trim().max(2000).nullable(),
	minimumAmount:z.number().nonnegative().max(100000000),
	maximumAmount:z.number().positive().max(100000000).nullable(),
	processingNotes:z.string().trim().max(1000).nullable(),
	displayOrder:z.number().int().min(0).max(10000),
}).refine(value=>value.maximumAmount===null||value.maximumAmount>=value.minimumAmount,{message:'Maximum amount must be at least the minimum amount.'});

export async function GET(){
	try{
		await requireAdmin();
		await db.paymentMethod.count();
		return NextResponse.json([],{headers:{'Cache-Control':'private, no-store'}});
	}catch{
		return NextResponse.json({error:'Forbidden'},{status:403});
	}
}

export async function POST(req:Request){
	try{
		await requireAdmin();
		return NextResponse.json({error:'External payment processing is disabled. Funding requests use internal simulation.'},{status:409});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}

export async function PATCH(req:Request){
	try{
		await requireAdmin();
		return NextResponse.json({error:'External payment processing is disabled. Existing records are retained for historical references.'},{status:409});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}