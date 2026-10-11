'use client';

import {useEffect,useState} from 'react';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {useSession} from 'next-auth/react';
import {Activity,ArrowDown,ArrowLeftRight,ArrowUp,Check,ChevronDown,ChevronLeft,ChevronRight,GripVertical,ListPlus,Plus,RefreshCw,Search,Star,Trash2,X} from 'lucide-react';
import Nav from '@/components/Nav';
import LivePriceChart from '@/components/LivePriceChart';
import {COMPARISON_SYMBOLS,DEFAULT_WATCHLIST,MARKET_ASSETS,TIMEFRAMES,getMarketAsset,type MarketCandle,type MarketQuote,type TimeframeId} from '@/lib/live-market';
import {getActiveWatchlist,setMarketWatchlistUserScope,useMarketWatchlists} from '@/lib/market-watchlists';

type QuoteError={asset:NonNullable<ReturnType<typeof getMarketAsset>>;error:string};
type QuotesResponse={quotes:Array<MarketQuote|QuoteError>;source:string};
type HistoryResponse={quote:MarketQuote;candles:MarketCandle[];timeframe:TimeframeId;interval:string;source?:string};
type ReturnMetric={label:string;days:number;value:number|null};

const TICKER_SYMBOLS=['BTC','DJI','MERV','DAX','IBEX','NIKKEI','EURGBP','SPX','NASDAQ'];

export default function LiveMarketDashboard(){
  const [queryClient]=useState(()=>new QueryClient({defaultOptions:{queries:{staleTime:4_000,refetchOnWindowFocus:true,retry:1}}}));
  return <QueryClientProvider client={queryClient}><LiveMarketDashboardContent/></QueryClientProvider>;
}

function LiveMarketDashboardContent(){
  const {data:session,status:sessionStatus}=useSession();
  const watchlists=useMarketWatchlists(state=>state.watchlists);
  const activeWatchlistId=useMarketWatchlists(state=>state.activeWatchlistId);
  const selectedSymbol=useMarketWatchlists(state=>state.selectedSymbol);
  const setActiveWatchlist=useMarketWatchlists(state=>state.setActiveWatchlist);
  const selectSymbol=useMarketWatchlists(state=>state.selectSymbol);
  const createWatchlist=useMarketWatchlists(state=>state.createWatchlist);
  const deleteActiveWatchlist=useMarketWatchlists(state=>state.deleteActiveWatchlist);
  const addSymbol=useMarketWatchlists(state=>state.addSymbol);
  const removeSymbol=useMarketWatchlists(state=>state.removeSymbol);
  const reorderSymbol=useMarketWatchlists(state=>state.reorderSymbol);
  const [timeframe,setTimeframe]=useState<TimeframeId>('1d');
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [showAddSymbol,setShowAddSymbol]=useState(false);
  const [showNewList,setShowNewList]=useState(false);
  const [newListName,setNewListName]=useState('');
  const [symbolSearch,setSymbolSearch]=useState('');
  const [draggedSymbol,setDraggedSymbol]=useState('');
  const [watchlistScopeReady,setWatchlistScopeReady]=useState(false);
  const [watchlistScopeError,setWatchlistScopeError]=useState('');
  const activeList=watchlists.find(list=>list.id===activeWatchlistId)||watchlists[0];
  const selectedAsset=getMarketAsset(selectedSymbol)||getMarketAsset('DJI')!;
  const quoteIds=Array.from(new Set([...activeList.symbols,...DEFAULT_WATCHLIST,...COMPARISON_SYMBOLS,selectedAsset.id]));
  const batchQuery=useQuery({queryKey:['live-market-quotes',quoteIds.join(',')],queryFn:()=>fetchQuotes(quoteIds),refetchInterval:30_000});
  const selectedQuery=useQuery({queryKey:['live-market-quote',selectedAsset.id],queryFn:async()=>{
    const result=await fetchQuotes([selectedAsset.id]);
    const failed=result.quotes.find(item=>item.asset.id===selectedAsset.id&&!isQuote(item));
    if(failed&&!isQuote(failed))throw new Error(failed.error);
    return result;
  },refetchInterval:5_000});
  const historyQuery=useQuery({queryKey:['live-market-history',selectedAsset.id,timeframe],queryFn:()=>fetchHistory(selectedAsset.id,timeframe),refetchInterval:timeframe==='1d'||timeframe==='5d'?15_000:60_000});
  const annualQuery=useQuery({queryKey:['live-market-history',selectedAsset.id,'1y'],queryFn:()=>fetchHistory(selectedAsset.id,'1y'),refetchInterval:60_000,staleTime:45_000,enabled:timeframe!=='1y'});
  const activeQuote=getQuote(selectedQuery.data,selectedAsset.id)||historyQuery.data?.quote;
  const batchQuotes=new Map((batchQuery.data?.quotes||[]).map(item=>[item.asset.id,item]));
  const error=historyQuery.error instanceof Error?historyQuery.error.message:selectedQuery.error instanceof Error?selectedQuery.error.message:'';

  useEffect(()=>{if(!getMarketAsset(selectedSymbol))selectSymbol('DJI')},[selectedSymbol,selectSymbol]);
  useEffect(()=>{
    if(sessionStatus==='loading')return;
    let active=true;
    setWatchlistScopeReady(false);
    setWatchlistScopeError('');
    void setMarketWatchlistUserScope(session?.user?.id||null).then(()=>{
      if(active)setWatchlistScopeReady(true);
    }).catch(()=>{
      if(active){setWatchlistScopeError('Unable to restore this account’s watchlists.');setWatchlistScopeReady(true);}
    });
    return()=>{active=false};
  },[session?.user?.id,sessionStatus]);

  function submitWatchlist(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    const name=newListName.trim();
    if(!name)return;
    createWatchlist(name);setNewListName('');setShowNewList(false);
  }

  function onDrop(event:React.DragEvent<HTMLButtonElement>,target:string){
    event.preventDefault();
    const source=event.dataTransfer.getData('text/plain')||draggedSymbol;
    if(source)reorderSymbol(source,target);
    setDraggedSymbol('');
  }

  const filteredAssets=MARKET_ASSETS.filter(asset=>!activeList.symbols.includes(asset.id)&&`${asset.id} ${asset.name} ${asset.ticker}`.toLowerCase().includes(symbolSearch.toLowerCase())).slice(0,7);
  const performance=returnMetrics(annualQuery.data?.candles||historyQuery.data?.candles||[],activeQuote);
  const todayRange=activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined&&activeQuote?.dayHigh!==null&&activeQuote?.dayHigh!==undefined?activeQuote.dayHigh-activeQuote.dayLow:null;
  const todayPosition=todayRange&&activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined?Math.max(0,Math.min(100,(activeQuote.price-activeQuote.dayLow)/todayRange*100)):50;

  return <><Nav/><main className="live-market-page">
    <div className="live-market-topline">
      <div className="live-market-heading"><span>MERCADOS GLOBALES <i/> {activeQuote?.isStale?'ÚLTIMO DATO GUARDADO':activeQuote?'DATOS DEL PROVEEDOR':'DATOS NO DISPONIBLES'}</span><h1>Mercados</h1><p>Precios de mercado y gráficos de {activeQuote?.source||'un proveedor disponible'}.</p></div>
      <div className={`live-source-status ${activeQuote?.isStale?'is-stale':''}`}><span className="live-status-dot"/>{activeQuote?.source||'Proveedor no disponible'} <small>{activeQuote?.isStale?`Último dato guardado · ${formatTime(activeQuote.updatedAt)}`:activeQuote?`Actualizado ${formatTime(activeQuote.updatedAt)}`:'Esperando cotizaciones'}</small></div>
    </div>

    <section className="live-ticker" aria-label="Ticker de mercados">
      <div className="live-ticker-label"><Activity size={14}/> EN VIVO</div>
      <div className="live-ticker-track">
        {TICKER_SYMBOLS.map(id=>{
          const item=batchQuotes.get(id);
          return <button type="button" className={`live-ticker-item ${selectedAsset.id===id?'is-active':''}`} key={id} onClick={()=>selectSymbol(id)}>
            <span>{id}</span>{isQuote(item)?<><strong>{formatPrice(item.price,item.asset.currency,item.asset.type==='FOREX')}</strong><em className={tone(item.changePercent)}>{item.changePercent>=0?'▲':'▼'} {formatPercent(item.changePercent)}</em></>:<small className="live-unavailable">{item?'No disponible':'···'}</small>}
          </button>;
        })}
      </div>
    </section>

    <div className={`live-market-grid ${sidebarOpen?'sidebar-mobile-open':''}`}>
      <aside className="live-sidebar" aria-label="Listas de seguimiento" aria-busy={!watchlistScopeReady}>
        <div className="live-sidebar-heading"><div><span>PORTAFOLIO</span><h2>Mi lista de control</h2></div><button className="live-icon-button live-mobile-close" type="button" aria-label="Cerrar listas" onClick={()=>setSidebarOpen(false)}><X size={17}/></button></div>
        {watchlistScopeError&&<div className="live-data-alert" role="alert">{watchlistScopeError}</div>}
        <div className="live-watchlist-controls">
          <label className="sr-only" htmlFor="watchlist-select">Lista de seguimiento</label>
          <select id="watchlist-select" value={activeList.id} onChange={event=>setActiveWatchlist(event.target.value)}>
            {watchlists.map(list=><option key={list.id} value={list.id}>{list.name}</option>)}
          </select><ChevronDown size={14}/>
          <button className="live-icon-button" type="button" aria-label="Crear lista de seguimiento" title="Nueva lista de seguimiento" onClick={()=>setShowNewList(!showNewList)}><ListPlus size={16}/></button>
        </div>
        {showNewList&&<form className="live-new-list" onSubmit={submitWatchlist}><input autoFocus value={newListName} onChange={event=>setNewListName(event.target.value)} placeholder="Nombre de la lista" aria-label="Nombre de la nueva lista" maxLength={36}/><button type="submit" aria-label="Guardar lista" disabled={!newListName.trim()}><Check size={15}/></button></form>}
        <div className="live-watchlist-actions"><span>{activeList.symbols.length} ACTIVOS</span><button type="button" onClick={()=>setShowAddSymbol(!showAddSymbol)}><Plus size={13}/> Añadir símbolo</button>{watchlists.length>1&&<button type="button" title="Eliminar esta lista" aria-label="Eliminar esta lista" onClick={deleteActiveWatchlist}><Trash2 size={13}/></button>}</div>
        {showAddSymbol&&<div className="live-symbol-picker"><label className="live-search"><Search size={14}/><input value={symbolSearch} onChange={event=>setSymbolSearch(event.target.value)} placeholder="Buscar símbolo" aria-label="Buscar símbolo para añadir"/></label><div className="live-symbol-results">{filteredAssets.length?filteredAssets.map(asset=><button type="button" key={asset.id} onClick={()=>{addSymbol(asset.id);setSymbolSearch('')}}><span><b>{asset.id}</b><small>{asset.name}</small></span><Plus size={14}/></button>):<p>No hay más símbolos disponibles.</p>}</div></div>}

        <div className="live-watchlist-items" aria-label="Activos de la lista">
          {activeList.symbols.map(id=>{
            const asset=getMarketAsset(id);
            const item=batchQuotes.get(id);
            if(!asset)return null;
            return <button type="button" key={id} draggable onDragStart={event=>{setDraggedSymbol(id);event.dataTransfer.setData('text/plain',id)}} onDragOver={event=>event.preventDefault()} onDrop={event=>onDrop(event,id)} onDragEnd={()=>setDraggedSymbol('')} className={`live-watch-row ${selectedAsset.id===id?'is-selected':''} ${draggedSymbol===id?'is-dragged':''}`} onClick={()=>selectSymbol(id)} aria-pressed={selectedAsset.id===id}>
              <GripVertical className="live-drag-handle" size={14}/><span className="live-watch-main"><b>{id}</b><small>{asset.name}</small></span>
              {isQuote(item)?<><Sparkline values={item.sparkline} positive={item.changePercent>=0}/><span className="live-watch-numbers"><b>{formatPrice(item.price,item.asset.currency,item.asset.type==='FOREX')}</b><small className={tone(item.changePercent)}>{formatPercent(item.changePercent)}</small></span></>:<span className="live-watch-numbers"><b className="live-muted">{item?'N/D':'···'}</b><small>{item?'No disponible':'Cargando'}</small></span>}
              <span role="presentation" className="live-remove-symbol" title={`Quitar ${id}`} onClick={event=>{event.stopPropagation();removeSymbol(id)}}><X size={13}/></span>
            </button>;
          })}
          {!activeList.symbols.length&&<div className="live-empty-watchlist">Añade símbolos para seguir sus cotizaciones.</div>}
        </div>

        <div className="live-suggestions"><div className="live-sidebar-heading"><div><span>DESCUBRIR</span><h2>Sugerencias para ti</h2></div><Star size={15}/></div>{['NVDA','AAPL','MSFT','TSLA'].filter(id=>!activeList.symbols.includes(id)).map(id=>{const asset=getMarketAsset(id)!;return <div className="live-suggestion" key={id}><button type="button" onClick={()=>selectSymbol(id)}><b>{id}</b><small>{asset.name}</small></button><button className="live-add-suggestion" type="button" aria-label={`Añadir ${id} a la lista`} onClick={()=>addSymbol(id)}><Plus size={14}/></button></div>})}</div>
        <div className="live-sidebar-foot">Arrastra activos para reordenar<br/>Tus listas se guardan por cuenta en este dispositivo.</div>
      </aside>

      <section className="live-main-column">
        <div className="live-chart-card">
          <div className="live-asset-title">
            <div className="live-asset-id"><span>{symbolBadge(selectedAsset.type)}</span><div><div className="live-symbol-line"><span>{selectedAsset.id}</span><span className="live-market-tag">{marketTypeLabel(selectedAsset.type)}</span></div><h2>{selectedAsset.name}</h2></div></div>
            <button className="live-mobile-list-button" type="button" aria-expanded={sidebarOpen} onClick={()=>setSidebarOpen(!sidebarOpen)}><ArrowLeftRight size={15}/> Listas</button>
          </div>
          <div className="live-price-line">
            <strong>{activeQuote?formatPrice(activeQuote.price,selectedAsset.currency,selectedAsset.type==='FOREX'):historyQuery.isLoading?'···':'—'}</strong>
            {activeQuote&&<span className={`live-change ${tone(activeQuote.changePercent)}`}><b>{activeQuote.change>=0?'+':''}{formatPrice(activeQuote.change,selectedAsset.currency,selectedAsset.type==='FOREX')}</b><b>({formatPercent(activeQuote.changePercent)})</b></span>}
            <span className="live-market-open-state"><i/> {marketOpenLabel(selectedAsset.type)}</span>
          </div>
          <div className="live-chart-metadata"><span>{activeQuote?.isStale?'Último dato · DESACTUALIZADO': 'Último dato'} {activeQuote?formatTime(activeQuote.updatedAt):'—'}</span><span>Fuente <b>{activeQuote?.source||historyQuery.data?.source||'No disponible'}</b></span><button type="button" className="live-refresh-button" aria-label="Actualizar cotizaciones" onClick={()=>{void selectedQuery.refetch();void batchQuery.refetch();void historyQuery.refetch()}}><RefreshCw size={13} className={selectedQuery.isFetching?'is-spinning':''}/> Actualizar</button></div>
          {activeQuote?.isStale&&<div className="live-data-alert" role="status">Proveedor no disponible. Se muestra el último precio recibido, no una cotización en vivo.{activeQuote.staleReason?` ${activeQuote.staleReason}`:''}</div>}
          <div className="live-timeframes" role="group" aria-label="Intervalo del gráfico">{TIMEFRAMES.map(item=><button type="button" key={item.id} className={timeframe===item.id?'is-active':''} aria-pressed={timeframe===item.id} onClick={()=>setTimeframe(item.id)}>{item.label}</button>)}</div>
          <LivePriceChart candles={historyQuery.data?.candles||[]} quote={activeQuote} timeframe={timeframe} loading={historyQuery.isLoading} error={historyQuery.error instanceof Error?historyQuery.error.message:''}/>
          {error&&<div className="live-data-alert" role="alert">No se pudo actualizar el gráfico. Se conservan los datos históricos disponibles. <button type="button" onClick={()=>void historyQuery.refetch()}>Reintentar</button></div>}
          <div className="live-chart-stats">
            <Metric label="Volumen" value={activeQuote?.volume===null||activeQuote?.volume===undefined?'—':formatCompact(activeQuote.volume)}/>
            <Metric label="Apertura" value={activeQuote?formatPrice(activeQuote.open??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="Cierre anterior" value={activeQuote?formatPrice(activeQuote.previousClose??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="Mín. 52 semanas" value={activeQuote?formatPrice(activeQuote.fiftyTwoWeekLow??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="Máx. 52 semanas" value={activeQuote?formatPrice(activeQuote.fiftyTwoWeekHigh??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
          </div>
          {todayPosition!==50&&<div className="live-day-range"><div><span>Rango del día</span><span>{formatPrice(activeQuote!.dayLow!,selectedAsset.currency,selectedAsset.type==='FOREX')} <b>{formatPrice(activeQuote!.dayHigh!,selectedAsset.currency,selectedAsset.type==='FOREX')}</b></span></div><div className="live-range-track"><i style={{left:`${todayPosition}%`}}/></div></div>}
          <div className="live-performance">{performance.map(metric=><div key={metric.label}><span>{metric.label}</span><b className={metric.value===null?'':tone(metric.value)}>{metric.value===null?'—':formatPercent(metric.value)}</b></div>)}</div>
        </div>

        <section className="live-comparison-section"><div className="live-section-title"><div><span>REFERENCIAS DE MERCADO</span><h2>Comparación rápida</h2></div><span className="live-source-note">Variación diaria · datos en vivo</span></div><div className="live-comparison-grid">{COMPARISON_SYMBOLS.map(id=>{const quote=batchQuotes.get(id);const asset=getMarketAsset(id)!;return <button type="button" className={`live-comparison-card ${selectedAsset.id===id?'is-active':''}`} key={id} onClick={()=>selectSymbol(id)}><span>{id}</span><small>{asset.name}</small><strong className={isQuote(quote)?tone(quote.changePercent):''}>{isQuote(quote)?formatPercent(quote.changePercent):'—'}</strong><em>{isQuote(quote)?formatPrice(quote.price,quote.asset.currency):quote?'No disponible':'Actualizando'}</em></button>})}</div></section>
      </section>

      <aside className="live-right-panel">
        <section className="live-right-card"><div className="live-section-title"><div><span>RESUMEN DEL ACTIVO</span><h2>Datos clave</h2></div></div>
          <div className="live-key-row"><span>Precio</span><b>{activeQuote?formatPrice(activeQuote.price,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}</b></div>
          <div className="live-key-row"><span>Variación</span><b className={activeQuote?tone(activeQuote.changePercent):''}>{activeQuote?formatPercent(activeQuote.changePercent):'—'}</b></div>
          <div className="live-key-row"><span>Moneda</span><b>{selectedAsset.currency}</b></div>
          <div className="live-key-row"><span>Tipo</span><b>{marketTypeLabel(selectedAsset.type)}</b></div>
          <div className="live-key-row"><span>Rango diario</span><b>{activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined&&activeQuote.dayHigh!==null?`${formatPrice(activeQuote.dayLow,selectedAsset.currency)} – ${formatPrice(activeQuote.dayHigh,selectedAsset.currency)}`:'—'}</b></div>
        </section>
        <section className="live-right-card live-provider-card"><span className="live-provider-mark">{activeQuote?.source==='Finnhub'?'F':'Y!'}</span><div><b>{activeQuote?.source||'Proveedor no disponible'}</b><small>Proveedor de cotizaciones</small></div><span className="live-provider-dot" title={activeQuote?.source?'Proveedor respondió con una cotización':'Sin cotización disponible'}/></section>
        <p className="live-disclaimer">{activeQuote?`Los datos son proporcionados por ${activeQuote.source} y pueden tener retraso.`:'Las cotizaciones no están disponibles en este momento.'} No es asesoramiento financiero ni una conexión de ejecución bursátil.</p>
      </aside>
    </div>
  </main></>;
}

function Metric({label,value}:{label:string;value:string}){return <div className="live-stat"><span>{label}</span><b>{value}</b></div>}

function Sparkline({values,positive}:{values:number[];positive:boolean}){
  if(values.length<2)return <span className="live-spark-empty" aria-label="No hay histórico suficiente"/>;
  const low=Math.min(...values),high=Math.max(...values),range=high-low||1;
  const points=values.map((value,index)=>`${(index/(values.length-1))*100},${26-((value-low)/range)*22}`).join(' ');
  return <svg className={`live-sparkline ${positive?'is-up':'is-down'}`} viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="Tendencia del precio intradía"><polyline points={points}/></svg>;
}

function isQuote(item:MarketQuote|QuoteError|undefined):item is MarketQuote{return !!item&&'price'in item;}
function getQuote(data:QuotesResponse|undefined,id:string){return data?.quotes.find(item=>item.asset.id===id&&isQuote(item)) as MarketQuote|undefined;}

async function fetchQuotes(symbols:string[]):Promise<QuotesResponse>{
  const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(symbols.join(','))}`,{cache:'no-store'});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||'Live market quotes are unavailable.');
  return body as QuotesResponse;
}

async function fetchHistory(symbol:string,timeframe:TimeframeId):Promise<HistoryResponse>{
  const response=await fetch(`/api/live-markets/${encodeURIComponent(symbol)}?timeframe=${timeframe}`,{cache:'no-store'});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||'Historical market data is unavailable.');
  return body as HistoryResponse;
}

function returnMetrics(candles:MarketCandle[],quote?:MarketQuote):ReturnMetric[]{
  const days:[string,number][]=[['1m',30],['3m',90],['6m',180],['1a',365]];
  const current=quote?.price??candles[candles.length-1]?.close;
  return days.map(([label,count])=>{
    const target=Date.now()/1000-count*24*60*60;
    const past=candles.find(candle=>candle.time>=target)||candles[0];
    return {label,days:count,value:current&&past?.close?(current/past.close-1)*100:null};
  });
}

function formatPrice(value:number,currency:string,forex=false){
  if(!Number.isFinite(value))return '—';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:forex?4:2,maximumFractionDigits:forex?5:2}).format(value)}catch{return value.toLocaleString(undefined,{maximumFractionDigits:5})}
}
function formatPercent(value:number){return `${value>=0?'+':''}${value.toFixed(2)}%`}
function formatCompact(value:number){return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(value)}
function formatTime(value:string){return new Date(value).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function tone(value:number){return value>=0?'is-positive':'is-negative'}
function marketTypeLabel(type:string){return ({INDEX:'ÍNDICE',STOCK:'ACCIÓN',FOREX:'DIVISA',CRYPTO:'CRIPTO'})[type as 'INDEX'|'STOCK'|'FOREX'|'CRYPTO']||type}
function marketOpenLabel(type:string){return type==='CRYPTO'?'Mercado abierto 24/7':'Mercado · última sesión disponible'}
function symbolBadge(type:string){return ({INDEX:'↗',STOCK:'◈',FOREX:'⇄',CRYPTO:'₿'})[type as 'INDEX'|'STOCK'|'FOREX'|'CRYPTO']||'↗'}