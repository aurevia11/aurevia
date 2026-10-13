import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {getFundingProviderReadiness} from '@/lib/providers/funding-provider';

export const dynamic='force-dynamic';

export async function GET(){
	let stage='authentication';
	try{
		const user=await requireUser();
		const demo=user.accountMode==='DEMO';
		const funding=demo?null:await getFundingProviderReadiness();
		const manualDepositReviewAvailable=!demo;
			const providerFundingAvailable=!!funding?.workflowEnabled;
		stage='database-query';
			const methods=await db.paymentMethod.findMany({where:{enabled:true,demoOnly:demo},orderBy:{displayOrder:'asc'},select:{id:true,name:true,currencies:true,destination:true,instructions:true,minimumAmount:true,maximumAmount:true,depositEnabled:true,withdrawalEnabled:true,requiresNetwork:true,demoOnly:true}});
			const realFundingAvailable=!demo&&(providerFundingAvailable||methods.some(method=>method.depositEnabled));
			const realWithdrawalAvailable=!demo&&providerFundingAvailable;
		stage='response-serialization';
		return NextResponse.json(jsonSafe({
			methods:methods.map(method=>demo?{...method,destination:null,instructions:'Demo request only. Do not send real funds. Any demo balance change requires administrator review.'}:method),
				fundingStatus:demo?'DEMO':providerFundingAvailable?'AVAILABLE':realFundingAvailable?'MANUAL_REVIEW':funding?.status||'NOT_CONFIGURED',
			realFundingAvailable,
				realWithdrawalAvailable,
				manualDepositReviewAvailable,
		}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		const errorType=error instanceof Error?error.name:'UnknownError';
		console.error(`Payment methods could not be loaded at ${stage} (${/^[A-Z0-9_]{2,32}$/.test(code)?code:errorType}).`);
		return NextResponse.json({error:'Payment methods are temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}