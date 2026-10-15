import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {anonymizeAccount} from '@/lib/account-deletion';
import {db} from '@/lib/db';
import {deletePrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';

const schema=z.object({userId:z.string().min(1),confirmation:z.literal('DELETE'),reason:z.string().trim().min(3).max(500)});

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-account-delete:${admin.id}`,10,60*60_000);
		const input=schema.parse(await request.json());
		const files=await db.$transaction(tx=>anonymizeAccount(tx,{userId:input.userId,actorId:admin.id,reason:input.reason}),{isolationLevel:'Serializable'});
		await Promise.all(files.map(file=>deletePrivateObject(file.area,file.ownerId,file.key)));
		return NextResponse.json({ok:true,userId:input.userId});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many account deletion attempts. Try again later.'},{status:429});
		if(error instanceof ZodError)return NextResponse.json({error:'Select an account, provide a reason, and confirm DELETE.'},{status:400});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_FOUND')return NextResponse.json({error:'Account not found.'},{status:404});
		if(error instanceof Error&&error.message==='LAST_ACTIVE_ADMIN_REQUIRED')return NextResponse.json({error:'The last active administrator account cannot be deleted.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_ALREADY_CLOSED')return NextResponse.json({error:'This account is already closed.'},{status:409});
		return NextResponse.json({error:'Account deletion could not be completed.'},{status:500});
	}
}