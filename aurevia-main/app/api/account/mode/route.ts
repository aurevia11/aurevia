import {NextResponse} from 'next/server';
import {z} from 'zod';
import {AccountMode,NotificationType} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {initializeDemoAccount} from '@/lib/ledger';

const schema=z.object({accountMode:z.nativeEnum(AccountMode)});

export async function PATCH(req:Request){
	try{
		const user=await requireUser();
		const {accountMode}=schema.parse(await req.json());
		const updated=await db.$transaction(async tx=>{
			const current=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{accountMode:true}});
			const demoAccountInitialized=accountMode===AccountMode.DEMO?await initializeDemoAccount(tx,user.id):false;
			const changed=await tx.user.update({where:{id:user.id},data:{accountMode},select:{accountMode:true,updatedAt:true}});
			if(current.accountMode!==accountMode||demoAccountInitialized){
								await tx.auditLog.create({data:{actorId:user.id,action:current.accountMode===accountMode?'DEMO_ACCOUNT_INITIALIZED':'ACCOUNT_MODE_CHANGED',entity:current.accountMode===accountMode?'LEDGER_ACCOUNT':'USER',entityId:user.id,metadata:{from:current.accountMode,to:accountMode,demoAccountInitialized}}});
				await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:demoAccountInitialized?'DEMO account initialized':'Account mode changed',message:demoAccountInitialized?'Your separate DEMO account received $5,000.00 virtual USD. No REAL funds were transferred.':`Your active account is now ${accountMode}. Balances and activity remain separate by mode.`,dedupeKey:`account-mode:${user.id}:${changed.updatedAt.toISOString()}`,actionUrl:'/dashboard'});
			}
			return {accountMode:changed.accountMode,demoAccountInitialized};
		});
		return NextResponse.json(updated);
	}catch{
		return NextResponse.json({error:'Unable to update account mode.'},{status:400});
	}
}