import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';
import {isBitcoinMainnetAddress,SIMULATED_BTC_ADDRESS_SETTING} from '@/lib/config/simulated-bitcoin-address';

export const dynamic='force-dynamic';

export async function GET(){
	try{
		await requireUser();
		const addressSetting=await db.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
		const address=addressSetting?.value.trim()||'';
		return NextResponse.json({
			methods:[],
			fundingStatus:'SIMULATED',
			simulationAvailable:true,
			supportedCurrencies:SUPPORTED_CURRENCIES,
			simulatedBitcoinAddress:address&&isBitcoinMainnetAddress(address)?address:null,
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