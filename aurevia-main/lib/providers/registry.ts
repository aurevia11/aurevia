import {createHmac,timingSafeEqual} from 'node:crypto';
import type {ExecutionProvider,ProviderConnectionState} from './contracts';
import {getServerConfiguration} from '@/lib/config/env';

let executionProvider:ExecutionProvider|null=null;
let statusProvider:ExecutionProvider|null=null;

export function getExecutionProvider(){return executionProvider;}

export function registerExecutionProvider(provider:ExecutionProvider,options:{executionEnabled?:boolean}={}){
	if(statusProvider)throw new Error('EXECUTION_PROVIDER_ALREADY_REGISTERED');
	statusProvider=provider;
	if(options.executionEnabled!==false)executionProvider=provider;
}

export async function getExecutionProviderStatus(){
	const config=getServerConfiguration().execution;
	const configuredHost=config.alpacaTradingBaseUrl?new URL(config.alpacaTradingBaseUrl).hostname:null;
	const providerMode=statusProvider?.executionMode??(configuredHost==='api.alpaca.markets'?'LIVE':configuredHost==='paper-api.alpaca.markets'?'PAPER':null);
	const configuredVariables={
		REAL_EXECUTION_ENABLED:Boolean(config.realEnabled),
		ALPACA_PROVIDER:config.alpacaProvider.toLowerCase()==='alpaca',
		ALPACA_TRADING_BASE_URL:config.alpacaTradingUrlConfigured,
		ALPACA_API_KEY:Boolean(config.alpacaTradingApiKey),
		ALPACA_API_SECRET:Boolean(config.alpacaTradingApiSecret),
		ALPACA_ACCOUNT_ID:Boolean(config.alpacaTradingAccountId),
	};
	const missingConfiguration=Object.entries(configuredVariables).filter(([name,configured])=>name!=='REAL_EXECUTION_ENABLED'&&!configured).map(([name])=>name);
	const selected=config.alpacaProvider.toLowerCase()==='alpaca';
	let alpacaStatus:'NOT_CONFIGURED'|'AVAILABLE'|'ERROR'|'DISABLED'='NOT_CONFIGURED';
	if(selected&&config.alpacaTradingUrlConfigured&&!config.alpacaTradingUrlValid)alpacaStatus='ERROR';
	else if(selected&&missingConfiguration.length===0&&statusProvider){
		if(statusProvider.executionMode==='LIVE'&&!config.realEnabled)alpacaStatus='DISABLED';
		else try{alpacaStatus=(await statusProvider.healthCheck()).connected?'AVAILABLE':'ERROR'}catch{alpacaStatus='ERROR'}
	}
	const state:ProviderConnectionState=!config.realEnabled?'DISABLED':!selected||missingConfiguration.length?'NOT_CONFIGURED':alpacaStatus==='ERROR'?'ERROR':executionProvider&&alpacaStatus==='AVAILABLE'?'CONNECTED':'DISABLED';
	return {
		state,
		enabled:config.realEnabled&&state==='CONNECTED'&&providerMode==='LIVE'&&executionProvider===statusProvider,
		providerName:config.provider,
		providerMode,
		alpacaTrading:{status:alpacaStatus,configured:selected&&config.alpacaTradingConfigured,mode:providerMode,realExecutionEnabled:config.realEnabled},
		adapterRegistered:!!executionProvider,
		configuredVariables,
		missingConfiguration,
		checkedAt:new Date().toISOString(),
	};
}

export function verifyHmacSha256(rawBody:string,signature:string,secret:string){
	const supplied=signature.startsWith('sha256=')?signature.slice(7):signature;
	if(!/^[a-fA-F0-9]{64}$/.test(supplied)||!secret)return false;
	const expected=createHmac('sha256',secret).update(rawBody,'utf8').digest();
	const actual=Buffer.from(supplied,'hex');
	return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export async function getExecutionProviderOrThrow(){
	const status=await getExecutionProviderStatus();
	if(status.state!=='CONNECTED'||!executionProvider)throw new Error('REAL_EXECUTION_UNAVAILABLE');
	return executionProvider;
}
