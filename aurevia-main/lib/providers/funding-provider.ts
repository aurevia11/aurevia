import type {FundingProvider} from './contracts';

let fundingProvider:FundingProvider|null=null;

export function getFundingProvider(){return fundingProvider;}

export function registerFundingProvider(provider:FundingProvider){
	if(fundingProvider)throw new Error('FUNDING_PROVIDER_ALREADY_REGISTERED');
	fundingProvider=provider;
}

export async function getFundingProviderReadiness(){
	if(!fundingProvider)return {status:'NOT_CONFIGURED' as const,providerName:null,connected:false,workflowEnabled:false,checkedAt:new Date().toISOString()};
	let connected=false;
	try{connected=(await fundingProvider.healthCheck()).connected}
	catch(error){
		console.error(`Funding provider health check failed (${error instanceof Error?error.name:'UnknownError'}).`);
	}
	return {
		status:connected?'DISABLED' as const:'ERROR' as const,
		providerName:fundingProvider.name,
		connected,
		workflowEnabled:false,
		checkedAt:new Date().toISOString(),
	};
}
