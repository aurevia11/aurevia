import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

export async function GET(_req:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const user=await requireUser();
		const funding=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:user.accountMode},include:{paymentMethod:{select:{name:true}},supportConversations:{where:{userId:user.id},select:{id:true,subject:true,status:true}}}});
		if(!funding)return NextResponse.json({error:'Transaction not found.'},{status:404});
		const history=await db.auditLog.findMany({where:{entity:'FUNDING',entityId:funding.id},select:{action:true,createdAt:true,actor:{select:{name:true,role:true}}},orderBy:{createdAt:'asc'}});
		return NextResponse.json(jsonSafe({transaction:funding,history}));
	}catch{
		return NextResponse.json({error:'Unable to load this transaction.'},{status:400});
	}
}