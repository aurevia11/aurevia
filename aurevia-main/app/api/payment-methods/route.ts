import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';

export const dynamic='force-dynamic';

export async function GET(){
	try{
		await requireUser();
		await db.$queryRaw`SELECT 1`;
		await db.fundingRequest.count();
		return NextResponse.json({
			methods:[],
			fundingStatus:'SIMULATED',
			simulationAvailable:true,
			supportedCurrencies:SUPPORTED_CURRENCIES,
			realFundingAvailable:true,
			realWithdrawalAvailable:true,
			manualDepositReviewAvailable:true,
			externalPaymentProcessing:'DISABLED',
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		return NextResponse.json({error:'Simulated funding workflows are temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}