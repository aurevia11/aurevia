import {getFinnhubHistory,getFinnhubQuote} from './providers/finnhub-market-data';

export type MarketAssetType = 'INDEX' | 'STOCK' | 'FOREX' | 'CRYPTO';

export type LiveMarketAsset = {
  id: string;
  ticker: string;
  name: string;
  type: MarketAssetType;
  currency: string;
};

export type MarketQuote = {
  asset: LiveMarketAsset;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number | null;
  open: number | null;
  volume: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  updatedAt: string;
  isStale?: boolean;
  staleReason?: string;
  sparkline: number[];
  source: string;
};

export type MarketCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export const MARKET_ASSETS: LiveMarketAsset[] = [
  {id:'DJI',ticker:'^DJI',name:'Dow Jones Industrial Average',type:'INDEX',currency:'USD'},
  {id:'SPX',ticker:'^GSPC',name:'S&P 500',type:'INDEX',currency:'USD'},
  {id:'NASDAQ',ticker:'^IXIC',name:'NASDAQ Composite',type:'INDEX',currency:'USD'},
  {id:'SP100',ticker:'^OEX',name:'S&P 100',type:'INDEX',currency:'USD'},
  {id:'NDX',ticker:'^NDX',name:'NASDAQ 100',type:'INDEX',currency:'USD'},
  {id:'DAX',ticker:'^GDAXI',name:'DAX Performance Index',type:'INDEX',currency:'EUR'},
  {id:'IBEX',ticker:'^IBEX',name:'IBEX 35',type:'INDEX',currency:'EUR'},
  {id:'NIKKEI',ticker:'^N225',name:'Nikkei 225',type:'INDEX',currency:'JPY'},
  {id:'MERV',ticker:'^MERV',name:'S&P Merval',type:'INDEX',currency:'ARS'},
  {id:'EURGBP',ticker:'EURGBP=X',name:'Euro / British Pound',type:'FOREX',currency:'GBP'},
  {id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},
  {id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD'},
  {id:'MSFT',ticker:'MSFT',name:'Microsoft Corporation',type:'STOCK',currency:'USD'},
  {id:'NVDA',ticker:'NVDA',name:'NVIDIA Corporation',type:'STOCK',currency:'USD'},
  {id:'AMZN',ticker:'AMZN',name:'Amazon.com, Inc.',type:'STOCK',currency:'USD'},
  {id:'GOOGL',ticker:'GOOGL',name:'Alphabet Inc.',type:'STOCK',currency:'USD'},
  {id:'TSLA',ticker:'TSLA',name:'Tesla, Inc.',type:'STOCK',currency:'USD'},
];

export const DEFAULT_WATCHLIST = ['DJI','SPX','NASDAQ','DAX','NIKKEI','BTC','EURGBP','IBEX','MERV'];
export const COMPARISON_SYMBOLS = ['SPX','NASDAQ','SP100','NDX'];

export const TIMEFRAMES = [
  {id:'1d',label:'1d',range:'1d',interval:'1m'},
  {id:'5d',label:'5d',range:'5d',interval:'5m'},
  {id:'1m',label:'1m',range:'1mo',interval:'30m'},
  {id:'3m',label:'3M',range:'3mo',interval:'1d'},
  {id:'ytd',label:'Año actual',range:'ytd',interval:'1d'},
  {id:'1y',label:'1a',range:'1y',interval:'1d'},
  {id:'3y',label:'3A',range:'5y',interval:'1wk'},
  {id:'5y',label:'5a',range:'5y',interval:'1wk'},
  {id:'max',label:'Máx.',range:'max',interval:'1mo'},
] as const;

export type TimeframeId = (typeof TIMEFRAMES)[number]['id'];

type YahooChartResult = {
  meta: Record<string, unknown>;
  timestamp?: number[];
  indicators?: {quote?: Array<{open?: Array<number|null>;high?: Array<number|null>;low?: Array<number|null>;close?: Array<number|null>;volume?: Array<number|null>}>};
};

type Cached<T> = {expiresAt:number;promise:Promise<T>};
const chartCache = new Map<string,Cached<YahooChartResult>>();
const quoteCache = new Map<string,Cached<MarketQuote>>();
const lastKnownQuoteCache = new Map<string,MarketQuote>();
const staleQuoteAgeMs=5*60_000;

export class MarketDataError extends Error {
  constructor(message:string,readonly status=502){super(message);this.name='MarketDataError';}
}

export function getMarketAsset(id:string){return MARKET_ASSETS.find(asset=>asset.id===id.toUpperCase());}

export function filterSupportedMarketAssets<T extends {symbol:string}>(assets:T[]):T[]{
  return assets.filter(asset=>!!getMarketAsset(asset.symbol));
}

function numberOrNull(value:unknown):number|null{
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}

function getCached<T>(cache:Map<string,Cached<T>>,key:string,ttl:number,loader:()=>Promise<T>):Promise<T>{
  const current=cache.get(key);
  if(current&&current.expiresAt>Date.now())return current.promise;
  const promise=loader().catch(error=>{cache.delete(key);throw error});
  cache.set(key,{expiresAt:Date.now()+ttl,promise});
  return promise;
}

async function fetchYahooChart(asset:LiveMarketAsset,range:string,interval:string):Promise<YahooChartResult>{
  const key=`${asset.id}:${range}:${interval}`;
  const ttl=range==='1d'?8_000:60_000;
  return getCached(chartCache,key,ttl,async()=>{
    const query=new URLSearchParams({range,interval,events:'div,splits'});
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.ticker)}?${query}`;
    let response:Response;
    try{response=await fetch(url,{cache:'no-store',headers:{'User-Agent':'Mozilla/5.0 (compatible; AureviaMarkets/1.0)'}})}
    catch{throw new MarketDataError('Live market data provider is unreachable.',503)}
    if(!response.ok)throw new MarketDataError(response.status===429?'Live market data is rate limited. Try again shortly.':'Live market data is temporarily unavailable.',response.status===429?503:502);
    const payload=await response.json() as {chart?:{error?:{description?:string};result?:YahooChartResult[]}};
    const result=payload.chart?.result?.[0];
    if(payload.chart?.error||!result)throw new MarketDataError(payload.chart?.error?.description||`No live data is available for ${asset.id}.`,404);
    return result;
  });
}

function latestNonNull(values:Array<number|null>|undefined):number|null{
  if(!values)return null;
  for(let index=values.length-1;index>=0;index--){const value=numberOrNull(values[index]);if(value!==null)return value;}
  return null;
}

function quoteFromResult(asset:LiveMarketAsset,result:YahooChartResult):MarketQuote{
  const meta=result.meta;
  const values=result.indicators?.quote?.[0];
  const price=numberOrNull(meta.regularMarketPrice)??latestNonNull(values?.close);
  if(price===null||price<=0)throw new MarketDataError(`No current price is available for ${asset.id}.`,404);
  const previousClose=numberOrNull(meta.chartPreviousClose)??numberOrNull(meta.previousClose);
  const change=numberOrNull(meta.regularMarketChange)??(previousClose!==null?price-previousClose:null);
  const changePercent=numberOrNull(meta.regularMarketChangePercent)??(previousClose!==null&&previousClose>0&&change!==null?change/previousClose*100:null);
  if(change===null||changePercent===null)throw new MarketDataError(`Daily change data is unavailable for ${asset.id}.`,404);
  const timestamps=result.timestamp||[];
  const marketTime=numberOrNull(meta.regularMarketTime)??numberOrNull(timestamps[timestamps.length-1]);
  if(marketTime===null||marketTime<=0)throw new MarketDataError(`Provider timestamp is unavailable for ${asset.id}.`,502);
  const sparkline=(values?.close||[]).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)).slice(-28);
  return {
    asset,price,change,changePercent:Number(changePercent.toFixed(6)),previousClose,
    open:numberOrNull(meta.regularMarketOpen)??latestNonNull(values?.open),
    volume:numberOrNull(meta.regularMarketVolume)??latestNonNull(values?.volume),
    dayLow:numberOrNull(meta.regularMarketDayLow),dayHigh:numberOrNull(meta.regularMarketDayHigh),
    fiftyTwoWeekLow:numberOrNull(meta.fiftyTwoWeekLow),fiftyTwoWeekHigh:numberOrNull(meta.fiftyTwoWeekHigh),
    updatedAt:new Date(marketTime*1000).toISOString(),sparkline,source:'Yahoo Finance',
  };
}

export async function getMarketQuote(asset:LiveMarketAsset,apiKey=''):Promise<MarketQuote>{
  try{
    const quote=await getCached(quoteCache,`${apiKey?'finnhub':'yahoo'}:${asset.id}`,5_000,async()=>{
      if(apiKey){
        try{return await getFinnhubQuote(asset,apiKey);}
        catch{try{return quoteFromResult(asset,await fetchYahooChart(asset,'1d','1m'));}catch{throw new MarketDataError('Configured market data providers are unavailable.',503);}}
      }
      return quoteFromResult(asset,await fetchYahooChart(asset,'1d','1m'));
    });
    const age=Date.now()-Date.parse(quote.updatedAt);
    const staleReason=age>staleQuoteAgeMs?'Provider quote timestamp is older than five minutes.':age< -5_000?'Provider quote timestamp is in the future.':undefined;
    const timestamped={...quote,isStale:!!staleReason,...(staleReason?{staleReason}:{})};
    lastKnownQuoteCache.set(asset.id,timestamped);
    return timestamped;
  }catch(error){
    const lastKnown=lastKnownQuoteCache.get(asset.id);
    if(!lastKnown)throw error;
    return {...lastKnown,isStale:true,staleReason:error instanceof Error?error.message:'Market data is temporarily unavailable.'};
  }
}

export async function getMarketHistory(asset:LiveMarketAsset,timeframe:TimeframeId,apiKey=''){
  const selection=TIMEFRAMES.find(item=>item.id===timeframe)||TIMEFRAMES[0];
  if(apiKey){
    try{return {...await getFinnhubHistory(asset,selection.range,selection.interval,apiKey),timeframe,interval:selection.interval};}
    catch{try{return await getYahooMarketHistory(asset,timeframe,selection);}catch{throw new MarketDataError('Configured market data providers are unavailable.',503);}}
  }
  return getYahooMarketHistory(asset,timeframe,selection);
}

async function getYahooMarketHistory(asset:LiveMarketAsset,timeframe:TimeframeId,selection:typeof TIMEFRAMES[number]){
  const result=await fetchYahooChart(asset,selection.range,selection.interval);
  const values=result.indicators?.quote?.[0];
  const timestamps=result.timestamp||[];
  const now=Date.now()/1000;
  const candles:MarketCandle[]=[];
  timestamps.forEach((time,index)=>{
    const open=numberOrNull(values?.open?.[index]);
    const high=numberOrNull(values?.high?.[index]);
    const low=numberOrNull(values?.low?.[index]);
    const close=numberOrNull(values?.close?.[index]);
    if(open===null||high===null||low===null||close===null)return;
    if(timeframe==='3y'&&time<now-3*365.25*24*60*60)return;
    candles.push({time,open,high,low,close,volume:numberOrNull(values?.volume?.[index])});
  });
  if(!candles.length)throw new MarketDataError(`No historical data is available for ${asset.id}.`,404);
  return {quote:quoteFromResult(asset,result),candles,timeframe,interval:selection.interval,source:'Yahoo Finance'};
}

export async function getLiveMarketProviderStatus(apiKey=''){
  const asset=getMarketAsset('AAPL')!;
  if(apiKey){
    try{await getFinnhubQuote(asset,apiKey);return {status:'AVAILABLE' as const,provider:'Finnhub',finnhubStatus:'AVAILABLE' as const,fallbackProvider:null};}
    catch{
      try{await fetchYahooChart(asset,'1d','1m');return {status:'ERROR' as const,provider:'Yahoo Finance (fallback)',finnhubStatus:'ERROR' as const,fallbackProvider:'Yahoo Finance'};}
      catch{return {status:'ERROR' as const,provider:'Unavailable',finnhubStatus:'ERROR' as const,fallbackProvider:null};}
    }
  }
  try{await fetchYahooChart(asset,'1d','1m');return {status:'AVAILABLE' as const,provider:'Yahoo Finance',finnhubStatus:'NOT_CONFIGURED' as const,fallbackProvider:null};}
  catch{return {status:'ERROR' as const,provider:'Unavailable',finnhubStatus:'NOT_CONFIGURED' as const,fallbackProvider:null};}
}