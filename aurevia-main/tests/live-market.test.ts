import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {filterSupportedMarketAssets,getMarketAsset,getMarketHistory,getMarketQuote,MarketDataError} from '../lib/live-market';

function chartResponse(price=41000,marketAgeSeconds=0,volume:Array<number|null>=[12,34]){
	const now=Math.floor(Date.now()/1000);
	const marketTime=now-marketAgeSeconds;
	return {
		chart:{result:[{
			meta:{regularMarketPrice:price,chartPreviousClose:40000,regularMarketChange:price-40000,regularMarketChangePercent:(price/40000-1)*100,regularMarketOpen:40500,regularMarketTime:marketTime,fiftyTwoWeekLow:25000,fiftyTwoWeekHigh:60000,currency:'USD'},
			timestamp:[marketTime-60,marketTime],
			indicators:{quote:[{open:[40000,40500],high:[40500,41500],low:[39900,40400],close:[40400,price],volume}]},
		}],error:null},
	};
}

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs()});

describe('live Yahoo market service',()=>{
	beforeEach(()=>vi.stubEnv('FINNHUB_API_KEY',''));
	it('parses a live quote and history candles from provider OHLCV',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(chartResponse()),{status:200,headers:{'content-type':'application/json'}}));
		vi.stubGlobal('fetch',fetcher);
		const asset=getMarketAsset('DJI')!;
		const quote=await getMarketQuote(asset);
		expect(quote.price).toBe(41000);
		expect(quote.change).toBe(1000);
		expect(quote.changePercent).toBe(2.5);
		expect(quote.fiftyTwoWeekLow).toBe(25000);
		const history=await getMarketHistory(asset,'1d');
		expect(history.candles).toHaveLength(2);
		expect(history.candles[1]).toMatchObject({open:40500,high:41500,low:40400,close:41000,volume:34});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('maps provider throttling to a retryable service error',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:429})));
		await expect(getMarketQuote(getMarketAsset('MERV')!)).rejects.toMatchObject({status:503});
	});

	it('returns the last successful quote with an explicit stale marker after provider failure',async()=>{
		const asset={id:'STALE_CACHE_TEST',ticker:'STALE_CACHE_TEST',name:'Stale cache test',type:'STOCK' as const,currency:'USD'};
		const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(chartResponse(123)),{status:200,headers:{'content-type':'application/json'}})).mockRejectedValueOnce(new Error('offline'));
		vi.stubGlobal('fetch',fetcher);
		const current=await getMarketQuote(asset);
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(9_000);
		const stale=await getMarketQuote(asset);
		expect(stale.price).toBe(current.price);
		expect(stale.isStale).toBe(true);
		expect(stale.staleReason).toContain('unreachable');
	});

	it('marks a successful provider response stale when its own quote timestamp is old',async()=>{
		const asset={id:'OLD_PROVIDER_QUOTE_TEST',ticker:'OLD_PROVIDER_QUOTE_TEST',name:'Old provider quote test',type:'STOCK' as const,currency:'USD'};
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(chartResponse(123,6*60)),{status:200,headers:{'content-type':'application/json'}})));
		const quote=await getMarketQuote(asset);
		expect(quote.isStale).toBe(true);
		expect(quote.staleReason).toContain('older than five minutes');
	});

	it('rejects unknown symbols at lookup',()=>{
		expect(getMarketAsset('NOT-A-REAL-SYMBOL')).toBeUndefined();
	});

	it('filters synthetic trading symbols from a market asset batch',()=>{
		const assets=[{symbol:'DJI'},{symbol:'E2E917F9FA/USD'}];
		expect(filterSupportedMarketAssets(assets)).toEqual([{symbol:'DJI'}]);
	});

	it('uses Finnhub quotes from the server-only key and identifies the actual source',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({c:190,d:2,dp:1.06,o:188,h:192,l:187,pc:188,t:Math.floor(Date.now()/1000)}),{status:200,headers:{'content-type':'application/json'}}));
		vi.stubGlobal('fetch',fetcher);
		const quote=await getMarketQuote(getMarketAsset('AAPL')!,'server-only-finnhub-test-key');
		expect(quote).toMatchObject({price:190,source:'Finnhub',change:2});
		expect(fetcher.mock.calls[0][1].headers['X-Finnhub-Token']).toBe('server-only-finnhub-test-key');
		expect(fetcher.mock.calls[0][0]).toContain('/quote?symbol=AAPL');
	});

	it('falls back to Yahoo real quotes on Finnhub failure and identifies Yahoo as the source',async()=>{
		const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response(JSON.stringify(chartResponse(191)),{status:200,headers:{'content-type':'application/json'}}));
		vi.stubGlobal('fetch',fetcher);
		const asset={id:'FINNHUB_FALLBACK_TEST',ticker:'AAPL',name:'Finnhub fallback test',type:'STOCK' as const,currency:'USD'};
		const quote=await getMarketQuote(asset,'invalid-test-key');
		expect(quote).toMatchObject({price:191,source:'Yahoo Finance'});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('does not fabricate prices when both market providers return no valid quote',async()=>{
		const emptyYahoo={chart:{result:[],error:null}};
		vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({c:0,d:0,dp:0,t:Math.floor(Date.now()/1000)}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(emptyYahoo),{status:200})));
		const asset={id:'NO_PRICE_TEST',ticker:'NO_PRICE_TEST',name:'No price test',type:'STOCK' as const,currency:'USD'};
		await expect(getMarketQuote(asset,'invalid-test-key')).rejects.toMatchObject({status:503});
	});

	it('rejects Yahoo quotes with no provider timestamp or daily comparison instead of inventing metadata',async()=>{
		const missingTimestamp={chart:{result:[{meta:{regularMarketPrice:42,chartPreviousClose:40},timestamp:[],indicators:{quote:[{close:[42]}]}}],error:null}};
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(missingTimestamp),{status:200})));
		const asset={id:'INCOMPLETE_QUOTE_TEST',ticker:'INCOMPLETE_QUOTE_TEST',name:'Incomplete quote test',type:'STOCK' as const,currency:'USD'};
		await expect(getMarketQuote(asset)).rejects.toBeInstanceOf(MarketDataError);
	});

	it('keeps missing historical volume unavailable rather than reporting zero',async()=>{
		const missingVolume=chartResponse(41000,0,[null,null]);
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(missingVolume),{status:200})));
		const asset={id:'NO_VOLUME_TEST',ticker:'NO_VOLUME_TEST',name:'No volume test',type:'STOCK' as const,currency:'USD'};
		const history=await getMarketHistory(asset,'1d');
		expect(history.candles[0].volume).toBeNull();
	});

	it('reads Finnhub historical candles without inventing missing bars',async()=>{
		const now=Math.floor(Date.now()/1000);
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({s:'ok',t:[now-60,now],o:[188,189],h:[190,192],l:[187,188],c:[189,191],v:[10,20]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({c:191,d:3,dp:1.59,o:189,h:192,l:188,pc:188,t:now}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const history=await (await import('../lib/live-market')).getMarketHistory(getMarketAsset('AAPL')!,'1d','test-finnhub-key');
		expect(history.source).toBe('Finnhub');
		expect(history.candles).toHaveLength(2);
		expect(history.candles[1]).toMatchObject({open:189,high:192,low:188,close:191,volume:20});
	});
});