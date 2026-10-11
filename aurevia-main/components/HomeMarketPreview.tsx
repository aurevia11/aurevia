'use client';

import {useEffect,useState} from 'react';
import PriceChart from '@/components/PriceChart';
import {useLocale} from '@/lib/i18n-context';

type MarketItem={id:string;symbol:string;name:string;price:number;change?:number};

export default function HomeMarketPreview(){
  const {translate}=useLocale();
  const [markets,setMarkets]=useState<MarketItem[]>([]);
  const [selected,setSelected]=useState('');
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');

  useEffect(()=>{
    let active=true;
    async function refresh(){
      try{
        const response=await fetch('/api/market',{cache:'no-store'});
        if(!response.ok)throw new Error('Market data unavailable');
        const data=await response.json() as MarketItem[];
        if(!active)return;
        const normalized=data.map(item=>({...item,price:Number(item.price)}));
        setMarkets(normalized);
        setSelected(current=>current||normalized.find(item=>item.symbol==='BTC/USD')?.id||normalized[0]?.id||'');
        setStatus('ready');
      }catch{if(active)setStatus(current=>current==='ready'?current:'error')}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),15_000);
    return()=>{active=false;window.clearInterval(timer)};
  },[]);

  const current=markets.find(item=>item.id===selected);
  const visibleMarkets=markets.slice(0,4);

  return <div className="market-stage" aria-label={translate('simulatedMarketPreview')}>
    <div className="market-stage-top">
      <div className="market-source"><span className="source-dot"/>{translate('demoEnvironment')} <span>{translate('simulatedMarketData')}</span></div>
      <span className="market-time">{translate('marketView')} <b>01</b></span>
    </div>
    <div className="market-stage-instrument">
      <div>
        <p className="eyebrow">{translate('selectedInstrument')}</p>
        <h2>{current?.symbol||translate('marketOverview')}</h2>
      </div>
      <div className="market-stage-price" aria-live="polite">
        {current?current.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:current.price<10?4:2}):status==='error'?translate('unavailable'):translate('loading')}
        <small>{translate('latestSimulatedPrice')} · USD</small>
      </div>
    </div>
    <div className="market-stage-chart">
      {current?<PriceChart price={current.price}/>:<div className="market-chart-empty" role="status">{status==='error'?translate('marketDataUnavailableRightNow'):translate('loadingDemoMarketData')}</div>}
      <div className="chart-axis-labels"><span>{translate('demoPriceLabel')}</span><span>{translate('marketFeedLabel')}</span></div>
    </div>
    <div className="market-stage-footer">
      <div className="market-pair-list" aria-label={translate('availableDemoInstruments')}>
        {visibleMarkets.map(item=><button key={item.id} type="button" className={item.id===selected?'is-selected':''} aria-pressed={item.id===selected} onClick={()=>setSelected(item.id)}>
          <span>{item.symbol}</span><b>{item.price.toLocaleString(undefined,{maximumFractionDigits:4})}</b>
        </button>)}
        {!visibleMarkets.length&&<span className="muted">{translate('noDemoInstrumentsAvailable')}</span>}
      </div>
      <span className="market-feed-status">{status==='ready'?translate('simulatedFeed'):translate('feedStatus',{status:status.toUpperCase()})}</span>
    </div>
  </div>;
}