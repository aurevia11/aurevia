import {NextResponse} from 'next/server';
import {getMarketAsset,getMarketHistory,MarketDataError,TIMEFRAMES,type TimeframeId} from '@/lib/live-market';
import {getServerConfiguration} from '@/lib/config/env';

export const dynamic='force-dynamic';
export const revalidate=0;

export async function GET(request:Request,{params}:{params:Promise<{symbol:string}>}){
  const {symbol}=await params;
  const asset=getMarketAsset(decodeURIComponent(symbol));
  if(!asset)return NextResponse.json({error:'Unsupported market symbol.'},{status:404});
  const requested=new URL(request.url).searchParams.get('timeframe')||'1d';
  if(!TIMEFRAMES.some(timeframe=>timeframe.id===requested))return NextResponse.json({error:'Unsupported timeframe.'},{status:400});
  try{
    const config=getServerConfiguration();
    const alpacaData=config.execution.alpacaProvider.toLowerCase()==='alpaca'?{apiKey:config.execution.alpacaTradingApiKey,apiSecret:config.execution.alpacaTradingApiSecret}:undefined;
    const history=await getMarketHistory(asset,requested as TimeframeId,config.marketData.finnhubApiKey,alpacaData);
    return NextResponse.json(history,{headers:{'Cache-Control':'public, s-maxage=15, stale-while-revalidate=30'}});
  }catch(error){
    const status=error instanceof MarketDataError?error.status:502;
    return NextResponse.json({error:error instanceof Error?error.message:'Historical market data is unavailable.'},{status});
  }
}