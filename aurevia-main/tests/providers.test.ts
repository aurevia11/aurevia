import {createHmac} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {getExecutionProviderOrThrow,getExecutionProviderStatus,registerExecutionProvider,verifyHmacSha256} from '../lib/providers/registry';
import {AlpacaCryptoProvider,IndividualAlpacaTradingProvider} from '../lib/providers/alpaca-crypto-provider';

afterEach(()=>vi.unstubAllEnvs());

describe('REAL execution provider readiness',()=>{
	it('remains disabled when the safety gate is not explicitly enabled',async()=>{
		vi.stubEnv('REAL_EXECUTION_ENABLED','false');
		const status=await getExecutionProviderStatus();
		expect(status.state).toBe('DISABLED');
		expect(status.adapterRegistered).toBe(false);
	});

	it('fails closed when the gate is enabled but provider configuration is incomplete',async()=>{
		vi.stubEnv('REAL_EXECUTION_ENABLED','true');
		vi.stubEnv('ALPACA_PROVIDER','alpaca');
		for(const name of ['ALPACA_TRADING_BASE_URL','ALPACA_API_KEY','ALPACA_API_SECRET','ALPACA_ACCOUNT_ID'])vi.stubEnv(name,'');
		const status=await getExecutionProviderStatus();
		expect(status.state).toBe('NOT_CONFIGURED');
		expect(status.missingConfiguration).toEqual(expect.arrayContaining([
			'ALPACA_TRADING_BASE_URL','ALPACA_API_KEY','ALPACA_API_SECRET','ALPACA_ACCOUNT_ID',
		]));
		await expect(getExecutionProviderOrThrow()).rejects.toThrow('REAL_EXECUTION_UNAVAILABLE');
	});

	it('verifies webhook HMACs and rejects malformed or incorrect signatures',()=>{
		const body='{"event":"order.updated"}';
		const secret='test-only-provider-webhook-secret';
		const signature=createHmac('sha256',secret).update(body).digest('hex');
		expect(verifyHmacSha256(body,`sha256=${signature}`,secret)).toBe(true);
		expect(verifyHmacSha256(body,signature,'different-test-secret')).toBe(false);
		expect(verifyHmacSha256(body,'not-a-signature',secret)).toBe(false);
	});

	it('health-checks configured Alpaca paper credentials without enabling REAL execution',async()=>{
		for(const [name,value] of Object.entries({
			REAL_EXECUTION_ENABLED:'false',
			ALPACA_PROVIDER:'alpaca',
			ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',
			ALPACA_API_KEY:'test-key',
			ALPACA_API_SECRET:'test-secret',
			ALPACA_ACCOUNT_ID:'test-account',
		}))vi.stubEnv(name,value);
		let authenticated=false;
		const fetcher=vi.fn().mockImplementation(()=>authenticated?{ok:true,status:200,json:async()=>({id:'paper-account'})}:{ok:false,status:401});
		registerExecutionProvider(new IndividualAlpacaTradingProvider({
			baseUrl:'https://paper-api.alpaca.markets',apiKey:'test-key',apiSecret:'test-secret',accountId:'test-account',fetcher,
		}),{executionEnabled:false});

		const failedStatus=await getExecutionProviderStatus();
		expect(failedStatus.alpacaTrading.status).toBe('ERROR');
		expect(failedStatus.enabled).toBe(false);
		authenticated=true;
		const status=await getExecutionProviderStatus();
		expect(status.providerMode).toBe('PAPER');
		expect(status.state).toBe('DISABLED');
		expect(status.enabled).toBe(false);
		expect(status.alpacaTrading.status).toBe('AVAILABLE');
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/account');
		expect(fetcher.mock.calls[0][1].method).toBeUndefined();
		expect(fetcher.mock.calls.every(([url])=>!String(url).includes('/orders'))).toBe(true);
		await expect(getExecutionProviderOrThrow()).rejects.toThrow('REAL_EXECUTION_UNAVAILABLE');
	});
});
