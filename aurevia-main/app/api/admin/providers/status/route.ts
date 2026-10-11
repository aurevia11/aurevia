import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {getExecutionProviderStatus} from '@/lib/providers/registry';
import {getIdentityComplianceProvider} from '@/lib/providers/identity-provider';
import {getLiveMarketProviderStatus} from '@/lib/live-market';
import {getServerConfiguration} from '@/lib/config/env';
import {getFundingProviderReadiness} from '@/lib/providers/funding-provider';

export const dynamic='force-dynamic';

function safeProviderLabel(value:string|null|undefined){
	if(!value)return null;
	return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value)?value:'Configured provider (name hidden)';
}

export async function GET(){
	try{
		await requireAdmin();
		const execution=await getExecutionProviderStatus();
		const marketProvider=await getLiveMarketProviderStatus(getServerConfiguration().marketData.finnhubApiKey);
		const identityProvider=getIdentityComplianceProvider();
		const funding=await getFundingProviderReadiness();
		return NextResponse.json({
			checkedAt:new Date().toISOString(),
			realExecution:{
				status:execution.state,
				enabled:execution.enabled,
				provider:safeProviderLabel(execution.providerName),
				providerMode:execution.providerMode,
				adapterRegistered:execution.adapterRegistered,
				configuredVariables:{...execution.configuredVariables,BROKER_API_KEY:Boolean(getServerConfiguration().execution.brokerApiKey)},
				missingConfiguration:execution.missingConfiguration,
				executionPathEnabled:execution.state==='CONNECTED',
				alpacaTrading:execution.alpacaTrading,
				cryptoCapabilities:{
					orderSubmission:execution.state==='CONNECTED',
					positionAndBalanceReconciliation:false,
					webhookPersistence:false,
				},
			},
			marketData:{
				status:marketProvider.status,
				provider:marketProvider.provider,
				finnhubStatus:marketProvider.finnhubStatus,
				fallbackProvider:marketProvider.fallbackProvider,
				usedForOrderExecution:false,
			},
			funding:{
				status:funding.status,
				provider:safeProviderLabel(funding.providerName),
				connected:funding.connected,
				workflowEnabled:funding.workflowEnabled,
				checkedAt:funding.checkedAt,
				realDepositsCreditOnlyOnProviderConfirmation:true,
			},
			investments:{
				status:'NOT_CONFIGURED',
				provider:null,
				realLifecycleActionsEnabled:false,
			},
			identity:{
				status:identityProvider?'CONFIGURED':'NOT_CONFIGURED',
				provider:safeProviderLabel(identityProvider?.name),
				adminReviewAvailable:true,
			},
			webhooks:{
				brokerAdapterRegistered:execution.adapterRegistered,
				signatureVerificationAvailable:execution.adapterRegistered,
			},
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}
