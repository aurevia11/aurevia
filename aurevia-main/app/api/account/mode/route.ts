import {NextResponse} from 'next/server';
import {z} from 'zod';
import {AccountMode,NotificationType} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {DEMO_STARTING_BALANCE,REAL_SIMULATED_STARTING_BALANCE,initializeDemoAccount,initializeRealSimulatedAccount} from '@/lib/ledger';

const schema=z.object({accountMode:z.nativeEnum(AccountMode)});

export async function PATCH(req:Request){
	try{
		const user=await requireUser();
		const {accountMode}=schema.parse(await req.json());
		const updated=await db.$transaction(async tx=>{
			const current=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{accountMode:true}});
			const demoAccountInitialized=accountMode===AccountMode.DEMO?await initializeDemoAccount(tx,user.id):false;
			const realAccountInitialized=accountMode===AccountMode.REAL?await initializeRealSimulatedAccount(tx,user.id):false;
			const changed=await tx.user.update({where:{id:user.id},data:{accountMode},select:{accountMode:true,updatedAt:true}});
			if(current.accountMode!==accountMode||demoAccountInitialized||realAccountInitialized){
				if(current.accountMode!==accountMode)await tx.auditLog.create({data:{actorId:user.id,action:'ACCOUNT_MODE_CHANGED',entity:'USER',entityId:user.id,metadata:{from:current.accountMode,to:accountMode}}});
				const initialized=demoAccountInitialized||realAccountInitialized;
				const startingBalance=demoAccountInitialized?DEMO_STARTING_BALANCE:REAL_SIMULATED_STARTING_BALANCE;
				await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:initialized?`${accountMode} simulated account initialized`:'Account mode changed',message:initialized?`Your separate ${accountMode} account received ${startingBalance.toFixed(2)} virtual USD. No real funds were transferred.`:`Your active account is now ${accountMode}. Balances and activity remain separate by mode.`,dedupeKey:`account-mode:${user.id}:${changed.updatedAt.toISOString()}`,actionUrl:'/dashboard'});
			}
			return {accountMode:changed.accountMode,demoAccountInitialized,realAccountInitialized};
		});
		return NextResponse.json(updated);
	}catch{
		return NextResponse.json({error:'Unable to update account mode.'},{status:400});
	}
}