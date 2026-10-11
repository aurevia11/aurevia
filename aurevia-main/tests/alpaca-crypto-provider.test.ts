import {afterEach,describe,expect,it,vi} from 'vitest';
import {AlpacaCryptoProvider,buildAlpacaCryptoClient,createIndividualTradingApiProviderFromEnvironment} from '../lib/providers/alpaca-crypto-provider';
import {AlpacaCryptoMarketDataProvider} from '../lib/providers/alpaca-crypto.market-data';

afterEach(()=>vi.unstubAllEnvs());

describe('Alpaca crypto provider safety',()=>{
	it('selects the Individual Trading API from ALPACA_PROVIDER and rejects unsafe URLs',()=>{
		for(const [name,value] of Object.entries({ALPACA_PROVIDER:'alpaca',ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets/',ALPACA_API_KEY:'test-key',ALPACA_API_SECRET:'test-secret',ALPACA_ACCOUNT_ID:'test-account',REAL_EXECUTION_ENABLED:'false'}))vi.stubEnv(name,value);
		const provider=createIndividualTradingApiProviderFromEnvironment();
		expect(provider?.name).toBe('individual-alpaca-trading');
		expect(provider?.executionMode).toBe('PAPER');
		vi.stubEnv('ALPACA_TRADING_BASE_URL','http://paper-api.alpaca.markets');
		expect(createIndividualTradingApiProviderFromEnvironment()).toBeNull();
	});

	it('accepts only sandbox broker endpoints for non-authorized execution',()=>{
		expect(()=>new AlpacaCryptoProvider({
			baseUrl:'https://broker-api.sandbox.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			webhookSecret:'test-webhook-secret',
		})).not.toThrow();
		expect(()=>new AlpacaCryptoProvider({
			baseUrl:'https://broker-api.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			webhookSecret:'test-webhook-secret',
		})).toThrow('SANDBOX_ONLY');
	});

	it('normalizes broker responses and preserves idempotency metadata',async()=>{
		const fetcher=vi.fn().mockResolvedValue({
			ok:true,
			status:200,
			json:async()=>({
				id:'11111111-1111-1111-1111-111111111111',
				client_order_id:'client-order',
				asset_id:'22222222-2222-2222-2222-222222222222',
				symbol:'BTCUSD',
				status:'accepted',
				filled_qty:'0',
				filled_at:null,
				created_at:'2026-01-01T00:00:00Z',
				updated_at:'2026-01-01T00:00:00Z',
				qty:'0.25',
			}),
		});
		const client=buildAlpacaCryptoClient({
			baseUrl:'https://broker-api.sandbox.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			fetcher,
		});
		const result=await client.submitOrder({
			clientOrderId:'client-order',
			assetId:'22222222-2222-2222-2222-222222222222',
			symbol:'BTCUSD',
			side:'buy',
			type:'market',
			timeInForce:'gtc',
			qty:'0.25',
		});
		expect(result.id).toBe('11111111-1111-1111-1111-111111111111');
		expect(result.clientOrderId).toBe('client-order');
		expect(result.status).toBe('accepted');
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('normalizes the documented quote map and preserves unavailable fields as null',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:60000,ap:60010,t:'2026-10-09T01:00:00Z'}}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		const quote=await provider.getQuote('BTC/USD');
		expect(quote).toEqual({symbol:'BTC/USD',price:null,bid:60000,ask:60010,open:null,high:null,low:null,previousClose:null,volume:null,marketStatus:'UNKNOWN',source:'Alpaca Crypto',asOf:'2026-10-09T01:00:00.000Z'});
		expect(fetcher.mock.calls[0][0]).toContain('symbols=BTC%2FUSD');
	});

	it('rejects incomplete quote payloads and reports provider health only after a valid response',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:0,ap:null}}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:60000,ap:60010,t:'2026-10-09T01:00:00Z'}}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		await expect(provider.getQuote('BTC/USD')).rejects.toThrow('ALPACA_MARKET_DATA_INVALID_QUOTE');
		await expect(provider.healthCheck()).resolves.toMatchObject({connected:true});
	});

	it('normalizes documented historical bars and does not invent volume',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({bars:{'BTC/USD':[{t:'2026-10-09T01:00:00Z',o:60000,h:60200,l:59900,c:60100}]}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		await expect(provider.getBars('BTC/USD','2026-10-09','2026-10-10','1Min')).resolves.toEqual([{time:'2026-10-09T01:00:00.000Z',open:60000,high:60200,low:59900,close:60100,volume:null}]);
	});
});
