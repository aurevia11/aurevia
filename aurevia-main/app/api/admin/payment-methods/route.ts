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
		return NextResponse.json(jsonSafe(await db.paymentMethod.findMany({orderBy:[{displayOrder:'asc'},{name:'asc'}]})));
	}catch{
		return NextResponse.json({error:'Forbidden'},{status:403});
	}
}

export async function POST(req:Request){
	try{
		const admin=await requireAdmin();
		const data=methodSchema.parse(await req.json());
		const method=await db.$transaction(async tx=>{
			const created=await tx.paymentMethod.create({data:{...data,currencies:[...new Set(data.currencies.map(currency=>currency.toUpperCase()))]}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'PAYMENT_METHOD_CREATED',entity:'PAYMENT_METHOD',entityId:created.id,metadata:{name:created.name}}});
			return created;
		});
		return NextResponse.json(jsonSafe(method),{status:201});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Check the payment method fields.'},{status:400});
		return NextResponse.json({error:'Unable to create payment method.'},{status:400});
	}
}

export async function PATCH(req:Request){
	try{
		const admin=await requireAdmin();
		const body=await req.json();
		const id=z.string().min(1).parse(body.id);
		const data=methodSchema.parse(body);
		const method=await db.$transaction(async tx=>{
			const updated=await tx.paymentMethod.update({where:{id},data:{...data,currencies:[...new Set(data.currencies.map(currency=>currency.toUpperCase()))]}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'PAYMENT_METHOD_UPDATED',entity:'PAYMENT_METHOD',entityId:updated.id,metadata:{name:updated.name,enabled:updated.enabled}}});
			return updated;
		});
		return NextResponse.json(jsonSafe(method));
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Check the payment method fields.'},{status:400});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'Payment method not found.'},{status:404});
		return NextResponse.json({error:'Unable to update payment method.'},{status:400});
	}
}