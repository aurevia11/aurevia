import {randomBytes,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {loadEnvConfig} from '@next/env';
import {AccountMode,PrismaClient,Role,UserStatus,NotificationType,FundingStatus,FundingType} from '@prisma/client';
import bcrypt from 'bcryptjs';
import {initializeDemoAccount} from '../../lib/ledger';

export default async function globalSetup(){
	const configuredE2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
	const configuredE2eDirectUrl=process.env.AUREVIA_E2E_DIRECT_URL;
	loadEnvConfig(process.cwd(),false,undefined,true);
	if(configuredE2eDatabaseUrl)process.env.AUREVIA_E2E_DATABASE_URL=configuredE2eDatabaseUrl;
	if(configuredE2eDirectUrl)process.env.AUREVIA_E2E_DIRECT_URL=configuredE2eDirectUrl;
	const databaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
	const directUrl=process.env.AUREVIA_E2E_DIRECT_URL;
	const localHosts=new Set(['localhost','127.0.0.1','::1']);
	function target(value:string|undefined,name:string){
		if(!value)throw new Error(`Refusing to create Playwright fixtures: ${name} is not set.`);
		let parsed:URL;
		try{parsed=new URL(value)}catch{throw new Error(`Refusing to create Playwright fixtures: ${name} is invalid.`)}
		const databaseName=decodeURIComponent(parsed.pathname.replace(/^\/+/,''));
		if(!['postgresql:','postgres:'].includes(parsed.protocol)||!localHosts.has(parsed.hostname)||!/_e2e$/i.test(databaseName))throw new Error(`Refusing to create Playwright fixtures: ${name} must target a local PostgreSQL database whose name ends in _e2e.`);
		return `${parsed.hostname}:${parsed.port||'5432'}/${databaseName}`;
	}
	if(target(databaseUrl,'AUREVIA_E2E_DATABASE_URL')!==target(directUrl,'AUREVIA_E2E_DIRECT_URL'))throw new Error('Refusing to create Playwright fixtures when E2E database URLs target different databases.');

	const db=new PrismaClient({datasourceUrl:databaseUrl});
	const runId=randomUUID();
	const userId=`e2e-user-${runId}`;
	const adminId=`e2e-admin-${runId}`;
	const legacyUserId=`e2e-legacy-user-${runId}`;
	const investorId=`e2e-investor-${runId}`;
	const userEmail=`aurevia-e2e-${runId}@example.invalid`;
	const adminEmail=`aurevia-e2e-admin-${runId}@example.invalid`;
	const legacyUserEmail=`aurevia-e2e-legacy-${runId}@example.invalid`;
	const investorEmail=`aurevia-e2e-investor-${runId}@example.invalid`;
	const userPassword=`Aa1!${randomBytes(20).toString('hex')}`;
	const adminPassword=`Aa1!${randomBytes(20).toString('hex')}`;
	const legacyUserPassword=`Aa1!${randomBytes(20).toString('hex')}`;
	const investorPassword=`Aa1!${randomBytes(20).toString('hex')}`;
	const registrationEmail=`aurevia-e2e-registration-${runId}@example.invalid`;
	const registrationPassword=`Aa1!${randomBytes(20).toString('hex')}`;
	let realDepositId='';
	let realWithdrawalId='';
	const symbols=[`E2E${runId.slice(0,6).toUpperCase()}A/USD`,`E2E${runId.slice(0,6).toUpperCase()}B/USD`];
	const instrumentIds:string[]=[];
	let paymentMethodId:string|undefined;
	const stateFile=join(tmpdir(),'aurevia-e2e-state.json');

	const state={runId,userId,adminId,legacyUserId,investorId,userEmail,adminEmail,legacyUserEmail,investorEmail,userPassword,adminPassword,legacyUserPassword,investorPassword,registrationEmail,registrationPassword,instrumentIds,symbols};
	process.env.AUREVIA_E2E_USER_EMAIL=userEmail;
	process.env.AUREVIA_E2E_USER_PASSWORD=userPassword;
	process.env.AUREVIA_E2E_ADMIN_EMAIL=adminEmail;
	process.env.AUREVIA_E2E_ADMIN_PASSWORD=adminPassword;
	process.env.AUREVIA_E2E_LEGACY_USER_EMAIL=legacyUserEmail;
	process.env.AUREVIA_E2E_LEGACY_USER_PASSWORD=legacyUserPassword;
	process.env.AUREVIA_E2E_INVESTOR_EMAIL=investorEmail;
	process.env.AUREVIA_E2E_INVESTOR_PASSWORD=investorPassword;
	process.env.AUREVIA_E2E_REGISTRATION_EMAIL=registrationEmail;
	process.env.AUREVIA_E2E_REGISTRATION_PASSWORD=registrationPassword;
	process.env.AUREVIA_E2E_INSTRUMENT_A=symbols[0];
	process.env.AUREVIA_E2E_INSTRUMENT_B=symbols[1];

	try{
		const paymentMethod=await db.paymentMethod.create({data:{name:`E2E internal payment ${runId}`,demoOnly:true,currencies:['USD'],minimumAmount:1,maximumAmount:10000,displayOrder:999}});
		paymentMethodId=paymentMethod.id;
		await db.user.create({data:{id:userId,email:userEmail,name:'Temporary E2E User',country:'Test',passwordHash:await bcrypt.hash(userPassword,10),accountMode:AccountMode.DEMO,status:UserStatus.ACTIVE,verifiedAt:new Date()}});
		await db.user.create({data:{id:adminId,email:adminEmail,name:'Temporary E2E Administrator',country:'Test',passwordHash:await bcrypt.hash(adminPassword,10),role:Role.ADMIN,accountMode:AccountMode.DEMO,status:UserStatus.ACTIVE,verifiedAt:new Date()}});
		await db.user.create({data:{id:legacyUserId,email:legacyUserEmail,name:'Legacy E2E User',country:'Test',passwordHash:await bcrypt.hash(legacyUserPassword,10),accountMode:AccountMode.DEMO,status:UserStatus.ACTIVE}});
				await db.user.create({data:{id:investorId,email:investorEmail,name:'Investment E2E User',country:'Test',passwordHash:await bcrypt.hash(investorPassword,10),accountMode:AccountMode.DEMO,status:UserStatus.ACTIVE,verifiedAt:new Date()}});
		const instruments=await Promise.all(symbols.map((symbol,index)=>db.instrument.create({data:{symbol,name:`E2E simulated instrument ${index+1}`,baseAsset:`E2E${index+1}`,quoteAsset:'USD',price:index===0?10:20,enabled:true}})));
		instrumentIds.push(...instruments.map(instrument=>instrument.id));
		await db.$transaction(async tx=>{
			await initializeDemoAccount(tx,userId);
			await initializeDemoAccount(tx,legacyUserId);
			await initializeDemoAccount(tx,investorId);
			await tx.kycProfile.create({data:{userId:investorId,legalName:'Investment E2E User',dob:new Date('1990-01-01'),address:'123 Test Street',idType:'PASSPORT',idNumber:`E2E-${runId}`,submittedAt:new Date()}});
			const document=await tx.kycDocument.create({data:{userId:investorId,kind:'IDENTITY_DOCUMENT',filename:'e2e-identity.pdf',storageKey:`${investorId}/${randomUUID()}.pdf`,mimeType:'application/pdf',size:128,status:'APPROVED'}});
			process.env.AUREVIA_E2E_KYC_DOCUMENT_ID=document.id;
			for(const [index,title] of ['E2E unread notification one','E2E unread notification two'].entries()){
				await tx.notification.create({data:{userId,type:NotificationType.SYSTEM,title,message:'Disposable Playwright notification fixture.',dedupeKey:`e2e:${runId}:notification:${index}`}});
			}
			const realDeposit=await tx.fundingRequest.create({data:{userId:investorId,type:FundingType.DEPOSIT,method:'UNVERIFIED_EXTERNAL',amount:125,currency:'USD',accountMode:AccountMode.REAL,status:FundingStatus.PENDING_REVIEW,idempotencyKey:`e2e:${runId}:real-deposit`}});
			realDepositId=realDeposit.id;
			const realWithdrawal=await tx.fundingRequest.create({data:{userId:investorId,type:FundingType.WITHDRAWAL,method:'UNVERIFIED_EXTERNAL',amount:25,currency:'USD',accountMode:AccountMode.REAL,status:FundingStatus.PENDING_REVIEW,idempotencyKey:`e2e:${runId}:real-withdrawal`}});
			realWithdrawalId=realWithdrawal.id;
		});
		process.env.AUREVIA_E2E_REAL_DEPOSIT_ID=realDepositId;
		process.env.AUREVIA_E2E_REAL_WITHDRAWAL_ID=realWithdrawalId;
				const cleanupState={runId,userId,adminId,legacyUserId,investorId,registrationEmail,instrumentIds,paymentMethodId};
		await writeFile(stateFile,JSON.stringify(cleanupState),{encoding:'utf8',mode:0o600});
	}catch(error){
				await cleanup(db,{...state,paymentMethodId}).catch(()=>undefined);
		throw error;
	}finally{
		await db.$disconnect();
	}
}

export async function cleanup(db:PrismaClient,state:{userId:string;adminId:string;legacyUserId?:string;investorId?:string;registrationEmail?:string;instrumentIds:string[];paymentMethodId?:string}){
	const registeredUser=state.registrationEmail?await db.user.findUnique({where:{email:state.registrationEmail},select:{id:true}}):null;
	const userIds=[state.userId,state.adminId,...(state.legacyUserId?[state.legacyUserId]:[]),...(state.investorId?[state.investorId]:[]),...(registeredUser?[registeredUser.id]:[])];
	await db.investmentRequest.deleteMany({where:{userId:{in:userIds}}});
	await db.investmentOpportunity.deleteMany({where:{createdById:{in:userIds}}});
	await db.auditLog.deleteMany({where:{OR:[{actorId:{in:userIds}},{entityId:{in:userIds}}]}});
	const accounts=await db.ledgerAccount.findMany({where:{userId:{in:userIds}},select:{id:true}});
	const accountIds=accounts.map(account=>account.id);
	if(accountIds.length){
		await db.ledgerTransaction.deleteMany({where:{entries:{some:{accountId:{in:accountIds}}}}});
		await db.ledgerEntry.deleteMany({where:{accountId:{in:accountIds}}});
		await db.ledgerAccount.deleteMany({where:{id:{in:accountIds}}});
	}
	await db.user.deleteMany({where:{id:{in:userIds}}});
	if(state.instrumentIds.length)await db.instrument.deleteMany({where:{id:{in:state.instrumentIds}}});
	if(state.paymentMethodId)await db.paymentMethod.deleteMany({where:{id:state.paymentMethodId}});
}
