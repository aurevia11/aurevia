import {NextResponse} from 'next/server';
import bcrypt from 'bcryptjs';
import {AccountMode,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {ensureUserLedger,ensureSystemAccount,initializeDemoAccount} from '@/lib/ledger';
import {rateLimit} from '@/lib/rate-limit';
import {issueVerificationCode} from '@/lib/verification';
import {registrationVerificationChannel,deliverVerificationCode} from '@/lib/verification-delivery';
import {verificationConfig} from '@/lib/config';
import {NotificationType} from '@prisma/client';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {getServerConfiguration} from '@/lib/config/env';

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().trim().min(2).max(120),
	country:z.string().trim().min(2).max(80),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().max(16).refine(value=>value===''||isValidE164(value),'Enter a valid phone number with its country code.').optional().or(z.literal('')),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true)
});

export async function POST(req:Request){
	try{
		rateLimit(`register:${req.headers.get('x-forwarded-for')||'unknown'}`,5,3600000);
		const p=schema.parse(await req.json());
		const email=p.email.toLowerCase();
		rateLimit(`register-email:${email}`,3,3600000);
		const serverVerificationConfig=getServerConfiguration().verification;
		const verificationEnabled=serverVerificationConfig.registrationVerificationEnabled;
		const phoneRequired=verificationEnabled&&serverVerificationConfig.phoneVerificationRequired;
		const channel=registrationVerificationChannel(p.phone||null,phoneRequired,verificationEnabled);
				const dateOfBirth=parseDateOfBirth(p.dateOfBirth);
				if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		if(phoneRequired&&!p.phone)return NextResponse.json({error:'A phone number is required when phone verification is enabled.'},{status:400});
		if(phoneRequired&&!channel){
			const error=process.env.NODE_ENV==='production'?'Account verification delivery is not configured. Please contact support.':'Development setup: verification delivery is not configured. Configure an email or SMS provider; no code was generated or exposed.';
			return NextResponse.json({error},{status:503});
		}
		const result=await db.$transaction(async tx=>{
			const created=await tx.user.create({data:{email,passwordHash:await bcrypt.hash(p.password,12),name:p.name,country:p.country,phone:p.phone||null,accountMode:p.accountMode,requiresRegistrationVerification:Boolean(channel),termsAcceptedAt:new Date()}});
			await tx.waitlistEntry.updateMany({where:{email, userId:null},data:{userId:created.id,status:'REGISTERED',updatedAt:new Date()}});
			await tx.kycProfile.upsert({where:{userId:created.id},update:{dob:dateOfBirth},create:{userId:created.id,dob:dateOfBirth}});
						if(created.accountMode===AccountMode.DEMO)await initializeDemoAccount(tx,created.id);
						else await ensureUserLedger(tx,created.id,created.accountMode);
			await ensureSystemAccount(tx,'SYSTEM:LIABILITY','Customer Funds');
			await createNotification(tx,{userId:created.id,type:NotificationType.ACCOUNT,title:'Account registration received',message:channel?'Complete the configured contact verification to finish registration.':'Your account is ready for sign-in. Phone verification is not enabled.',dedupeKey:`registration:${created.id}:created`,actionUrl:channel?'/register':'/dashboard'});
			await notifyActiveAdmins(tx,{type:NotificationType.ACCOUNT,title:'New account registration',message:`A new ${created.accountMode.toLowerCase()} account registration is awaiting review.`,dedupeKey:`registration:${created.id}:admin`,relatedEntity:'USER',relatedId:created.id,actionUrl:'/admin'});
			const challenge=channel?await issueVerificationCode(tx,created,channel):null;
			return {user:created,challenge};
		});
		if(!result.challenge)return NextResponse.json({message:'If this account can be created, you can continue to sign in.',verificationRequired:false},{status:202});
		const delivered=await deliverVerificationCode(result.challenge.channel,result.user,result.challenge.code);
		if(!delivered){
			await db.verificationCode.updateMany({where:{userId:result.user.id},data:{resendAfter:new Date()}});
			return NextResponse.json({error:'Verification delivery could not be completed. No code was sent. Request a replacement code or contact support.',verificationPending:true,channel:result.challenge.channel.toLowerCase(),resendAfterSeconds:0},{status:503});
		}
		return NextResponse.json({message:'If this account can be created, verification instructions have been sent.',verificationRequired:true,channel:result.challenge.channel.toLowerCase(),resendAfterSeconds:verificationConfig.resendCooldownSeconds},{status:202});
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number with its country code.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			const target=error.meta?.target;
			const fields=Array.isArray(target)?target.map(String):[String(target||'')];
			if(fields.includes('email'))return NextResponse.json({error:'An account with this email address already exists.'},{status:409});
			if(fields.includes('phone'))return NextResponse.json({error:'An account with this phone number already exists.'},{status:409});
			return NextResponse.json({error:'These registration details are already in use.'},{status:409});
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'The registration service is being updated. Please try again shortly.'},{status:503});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many registration attempts. Try again later.'},{status:429});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'The database is temporarily unavailable. Please try again shortly.'},{status:503});
		return NextResponse.json({error:'We could not complete registration. Please try again or contact support.'},{status:500});
	}
}
