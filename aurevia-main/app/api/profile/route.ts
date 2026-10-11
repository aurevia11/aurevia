import {NextResponse} from 'next/server';
import {AccountMode,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {getAccountTier} from '@/lib/production-policy';

const profileSelect={
	id:true,email:true,name:true,phone:true,phoneVerified:true,country:true,avatarKey:true,twoFactorEnabled:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,verifiedAt:true,verifiedChannel:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,updatedAt:true,
	kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true}},
	kyc:{select:{address:true,submittedAt:true}},
} satisfies Prisma.UserSelect;

type ProfileRecord=Prisma.UserGetPayload<{select:typeof profileSelect}>;

const schema=z.object({
	name:z.string().trim().min(2,'Enter a full name.').max(120,'Full name must be 120 characters or fewer.').optional(),
	firstName:z.string().trim().max(60,'First name must be 60 characters or fewer.').optional(),
	lastName:z.string().trim().max(60,'Last name must be 60 characters or fewer.').optional(),
	phone:z.string().trim().max(40,'Phone number must be 40 characters or fewer.').optional(),
	country:z.string().trim().max(80,'Country must be 80 characters or fewer.').optional(),
	address:z.string().trim().max(500,'Address must be 500 characters or fewer.').optional(),
	twoFactorEnabled:z.boolean().optional(),
}).refine(input=>input.name!==undefined||input.firstName!==undefined||input.lastName!==undefined,{message:'Enter your first name and last name.'});

function nameParts(name:string|null){
	const parts=(name||'').trim().split(/\s+/).filter(Boolean);
	return {firstName:parts[0]||'',lastName:parts.slice(1).join(' ')};
}

function profileResponse(profile:ProfileRecord){
	const {avatarKey,kyc,kycDocuments,...safeProfile}=profile;
	const {firstName,lastName}=nameParts(profile.name);
	const tier=getAccountTier({accountMode:profile.accountMode as AccountMode,kycStatus:profile.kycStatus,verificationDocuments:kycDocuments.length,verificationSubmitted:!!kyc?.submittedAt,approvedTier:profile.approvedTier});
	return {...safeProfile,firstName,lastName,address:kyc?.address||null,hasAvatar:!!avatarKey,twoFactorEnabled:false,twoFactorAvailable:false,documents:kycDocuments.length,verificationProfileSubmitted:!!kyc?.submittedAt,...tier};
}

function safeErrorDetails(error:unknown){
	const value=error&&typeof error==='object'?error as {code?:unknown;name?:unknown}:{};
	const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,31}$/.test(value.code)?value.code:undefined;
	const errorType=typeof value.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)?value.name:'UnknownError';
	return {code,errorType};
}

export async function GET(){
	try{
		const user=await requireUser();
		const profile=await db.user.findUnique({where:{id:user.id},select:profileSelect});
		if(!profile)return NextResponse.json({error:'Profile not found.'},{status:404});
		return NextResponse.json(profileResponse(profile),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		console.error('[profile] Read failed',safeErrorDetails(error));
		return NextResponse.json({error:'Unable to load profile. Please try again shortly.'},{status:503});
	}
}

export async function PATCH(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message||'Check the profile fields and try again.'},{status:400});
		const input=parsed.data;
		if(input.twoFactorEnabled)return NextResponse.json({error:'Two-factor authentication is unavailable and cannot be enabled.'},{status:409});
		const updated=await db.$transaction(async tx=>{
			const current=await tx.user.findUnique({where:{id:user.id},select:{name:true,phone:true,country:true,twoFactorEnabled:true}});
			if(!current)return null;
			const existingName=nameParts(current.name);
			const name=input.name!==undefined?input.name.replace(/\s+/g,' ').trim():[input.firstName??existingName.firstName,input.lastName??existingName.lastName].filter(Boolean).join(' ');
			if(name.length<2)return {validationError:'Enter a first name and a last name.'} as const;
			await tx.user.update({where:{id:user.id},data:{
				name,
				phone:input.phone===undefined?current.phone:input.phone||null,
				country:input.country===undefined?current.country:input.country||null,
				twoFactorEnabled:input.twoFactorEnabled===false?false:current.twoFactorEnabled,
			}});
			if(input.address!==undefined)await tx.kycProfile.upsert({where:{userId:user.id},update:{address:input.address||null},create:{userId:user.id,address:input.address||null}});
			const fresh=await tx.user.findUnique({where:{id:user.id},select:profileSelect});
			if(!fresh)return null;
			if(current.twoFactorEnabled&&input.twoFactorEnabled===false)await createNotification(tx,{userId:user.id,type:NotificationType.SECURITY,title:'Two-factor setting cleared',message:'Two-factor authentication is unavailable and is not protecting this account. No enrollment or login challenge is configured.',dedupeKey:`security:${user.id}:two-factor-disabled:${fresh.updatedAt.toISOString()}`,actionUrl:'/settings#security'});
			return fresh;
		});
		if(!updated)return NextResponse.json({error:'Profile not found.'},{status:404});
		if('validationError' in updated)return NextResponse.json({error:updated.validationError},{status:400});
		return NextResponse.json(profileResponse(updated),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||'Check the profile fields and try again.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Profile data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		console.error('[profile] Update failed',safeErrorDetails(error));
		return NextResponse.json({error:'Unable to save profile. Please try again shortly.'},{status:503});
	}
}