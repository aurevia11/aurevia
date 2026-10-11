"use client";
import { FormEvent, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import Nav from "@/components/Nav";
import { useLocale } from "@/lib/i18n-context";
import LiveMarketPreview from "@/components/LiveMarketPreview";
import PriceChart from "@/components/PriceChart";
import { useTradingStore } from "@/lib/store";
import { ArrowDownRight, ArrowUpRight, ChartNoAxesCombined, RefreshCw } from "lucide-react";
type I = { id: string; symbol: string; price: number; change?: number; takerFee?: number; leverage?: number; updatedAt?:string; lastUpdatedAt?:string };
type Order = {
  id: string;
  status: string;
  side: string;
  type: string;
  quantity: number;
  filledQuantity: number;
  price?: number;
  stopPrice?: number;
  instrument: { symbol: string };
};
type Pos = {
  id: string;
  side: string;
  quantity: number;
  entryPrice: number;
  margin: number;
  instrument: { symbol: string; price: number };
};
export default function Trade() {
  const { translate } = useLocale();
  const {data:session,status:sessionStatus}=useSession();
  const [items, setItems] = useState<I[]>([]);
  const updateStore = useTradingStore((s) => s.updatePrices);
  const [selected, setSelected] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [msg, setMsg] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [book, setBook] = useState<any>({ bids: [], asks: [] });
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [accountMode, setAccountMode] = useState<'DEMO'|'REAL'|'LOADING'>('LOADING');
  const [placing, setPlacing] = useState(false);
  useEffect(() => {
    if(sessionStatus!=='authenticated')return;
    let active = true;
    setAccountMode('LOADING');
    setAvailableBalance(null);
    setOrders([]);
    setPositions([]);
    setMsg('');
    const load = async () => {
      try {
        if(session?.user?.accountMode==='REAL'){
          const [orderResponse,walletResponse]=await Promise.all([fetch("/api/orders"),fetch("/api/wallet")]);
          if(!orderResponse.ok||!walletResponse.ok)throw new Error("Unable to load REAL account data.");
          const [orderData,walletData]=await Promise.all([orderResponse.json(),walletResponse.json()]);
          if(!active)return;
          setItems([]);setSelected("");setOrders(orderData);setPositions([]);setAccountMode('REAL');setAvailableBalance(Number(walletData.balance));
          return;
        }
        const responses = await Promise.all([
          fetch("/api/market"),
          fetch("/api/orders"),
          fetch("/api/positions"),
          fetch("/api/wallet"),
        ]);
        if (responses.some((response) => !response.ok))
          throw new Error("Unable to load trading data.");
        const [market, orderData, positionData, walletData] = await Promise.all(
          responses.map((response) => response.json()),
        );
        if (!active) return;
        setItems(
          market.map((item: I & {lastUpdatedAt?:string}) => ({ ...item, price: Number(item.price),updatedAt:item.lastUpdatedAt||item.updatedAt })),
        );
        if (market[0]) setSelected(market[0].id);
        setOrders(orderData);
        setAccountMode(walletData.accountMode);
        setAvailableBalance(Number(walletData.balance));
        setPositions(
          positionData.map((position: any) => ({
            ...position,
            quantity: Number(position.quantity),
            entryPrice: Number(position.entryPrice),
            margin: Number(position.margin),
            instrument: {
              ...position.instrument,
              price: Number(position.instrument.price),
            },
          })),
        );
      } catch {
        if (active)
          setMsg("Unable to load trading data. Refresh to try again.");
      }
    };
    void load();
    if(session?.user?.accountMode==='REAL')return()=>{active=false;};
    const refreshPrices=async()=>{
      try{
        const response=await fetch("/api/market",{cache:"no-store"});
        if(!response.ok)return;
        const market=await response.json() as Array<I & {lastUpdatedAt?:string}>;
        if(!active)return;
        const updates=market.map((item)=>({...item,price:Number(item.price),updatedAt:item.lastUpdatedAt||item.updatedAt}));
        setItems(updates);
        updateStore(updates);
      }catch{}
    };
    const timer=window.setInterval(()=>void refreshPrices(),15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [updateStore,sessionStatus,session?.user?.accountMode]);
  useEffect(() => {
    if (!selected||accountMode!=='DEMO') return;
    const load = () =>
      fetch(`/api/orderbook?instrumentId=${selected}`)
        .then((r) => r.json())
        .then(setBook);
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [selected,accountMode]);
  const cur = items.find((i) => i.id === selected);
  const pnl = (p: Pos) =>
    p.side === "BUY"
      ? ((cur?.price ?? p.instrument.price) - p.entryPrice) * p.quantity
      : (p.entryPrice - (cur?.price ?? p.instrument.price)) * p.quantity;
  const requestedQuantity = Number(qty);
  const estimatedNotional = (cur?.price ?? 0) * (Number.isFinite(requestedQuantity) ? requestedQuantity : 0);
  const estimatedFee = estimatedNotional * Number(cur?.takerFee ?? 0);
  const estimatedRequiredCash = estimatedNotional + estimatedFee;

  async function place(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(accountMode!=='DEMO'){setMsg(translate('realTradingUnavailable'));return;}
    if (placing) return;
    setPlacing(true);
    setMsg("");
    try {
      const body = {
        instrumentId: selected,
        side,
        type,
        quantity: Number(qty),
        price: type === "LIMIT" && price ? Number(price) : undefined,
        stopPrice: type === "STOP" && price ? Number(price) : undefined,
        expectedPrice:cur?.price,
        observedAt:cur?.updatedAt,
      };
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      setMsg(response.ok ? "Order accepted" : result.error || "Order failed");
      if (response.ok) {
        setOrders((current) => [result, ...current]);
        const positionResponse = await fetch("/api/positions");
        setPositions(await positionResponse.json());
      }
    } catch {
      setMsg("Unable to submit the order. Check your connection and try again.");
    } finally {
      setPlacing(false);
    }
  }
  async function cancel(id: string) {
    const r = await fetch("/api/orders", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: id }),
    });
    if (r.ok)
      setOrders((o) =>
        o.map((x) => (x.id === id ? { ...x, status: "CANCELLED" } : x)),
      );
  }
  async function close(id: string) {
    const r = await fetch("/api/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId: id }),
    });
    const j = await r.json();
    setMsg(r.ok ? "Position closed" : j.error || "Close failed");
    if (r.ok) setPositions((p) => p.filter((x) => x.id !== id));
  }
  return (
    <>
      <Nav />
      <main className="trade-terminal">
        <header className="account-heading"><div><span className="account-kicker">{accountMode==='LOADING'?translate('restoringAccountMode'):`${accountMode} ACCOUNT · ${translate('tradingWorkspace')}`}</span><h1>{translate('tradeMarkets')}</h1><p>{accountMode==='REAL'?translate('realAccountTradingDescription'):translate('tradeMarketsDescription')}</p></div><span className={`status-pill ${accountMode==='REAL'?'mode-real':'mode-demo'}`}>{accountMode==='LOADING'?'RESTORING':accountMode==='REAL'?'REAL · ACTIVE':'DEMO · SIMULATED'}</span></header>
        {accountMode==='REAL'?<div className="real-trade-view"><div className="account-callout"><span>{translate('realTradingNotice')}</span></div><section className="account-panel card p-5"><LiveMarketPreview/></section><section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('realExecutionStatus')}</h2><p className="account-panel-subtitle">{translate('realLedgerDescription')}</p></div><span className="status-pill mode-real">{translate('activeReadOnly')}</span></div><Link className="text-link" href="/markets">{translate('openLiveCharts')} <ArrowUpRight size={14}/></Link><Link className="text-link ml-4" href="/wallet">{translate('openRealWallet')} <ArrowUpRight size={14}/></Link></section></div>:accountMode==='DEMO'?<>
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <section className="card min-h-[650px] p-5">
            <div className="trade-market-select" role="group" aria-label={translate('selectAnInstrument')}>
              {items.map((i) => (
                <button
                  type="button"
                  key={i.id}
                  onClick={() => setSelected(i.id)}
                  className={`rounded-lg px-3 py-2 text-sm ${i.id === selected ? "bg-gold text-black" : "bg-white/5"}`}
                  aria-pressed={i.id === selected}
                >
                  {i.symbol}{" "}
                  {i.price.toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                </button>
              ))}
            </div>
            <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_220px]">
              <div className="trade-chart-panel">
                <div className="trade-chart-header"><div><span className="account-kicker">{cur?.symbol||translate('selectAnInstrument')}</span><p className="trade-last-price">{cur?.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:cur.price<10?4:2})||"—"}</p></div><span className="status-pill">{translate('simulatedPrice')}</span></div>
                <div className="sr-only">{translate('currentSimulatedPriceChart')}</div>
                <div className="hidden">
                  <div className="mb-2 text-4xl font-black">
                  {cur?.price.toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                  </div>
                </div>
                <PriceChart price={cur?.price ?? 0} />
                <p className="trade-chart-note">{translate('internalSimulatedMarket')}</p>
              </div>
              <div className="trade-orderbook">
                <h3 className="font-bold">{translate('orderBook')} <small>{translate('demoFeedOnly')}</small></h3>
                <div className="mt-3 text-xs">
                  {book.asks
                    ?.slice()
                    .reverse()
                    .map((x: any) => (
                      <div
                        key={x.price}
                        className="flex justify-between text-loss"
                      >
                        <span>{x.price.toFixed(6)}</span>
                        <span>{x.quantity}</span>
                      </div>
                    ))}
                  <div className="my-2 border-t border-white/10" />
                  {book.bids?.map((x: any) => (
                    <div
                      key={x.price}
                      className="flex justify-between text-profit"
                    >
                      <span>{x.price.toFixed(6)}</span>
                      <span>{x.quantity}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <section className="card p-5">
            <div className="account-panel-title"><div><h2>{translate('orderTicket')}</h2><p className="account-panel-subtitle">{translate('reviewDemoEstimate')}</p></div><span className="status-pill mode-demo">{translate('demo')}</span></div>
            <form onSubmit={place} className="space-y-3">
              <fieldset disabled={accountMode!=='DEMO'} className="space-y-3">
              <div className="grid grid-cols-2 gap-2" role="group" aria-label={translate('orderSide')}>
              <button type="button" aria-pressed={side === "BUY"}
                onClick={() => setSide("BUY")}
                className={`btn ${side === "BUY" ? "bg-profit text-black" : "bg-white/5"}`}
              >
                {translate('buy')}
              </button>
              <button type="button" aria-pressed={side === "SELL"}
                onClick={() => setSide("SELL")}
                className={`btn ${side === "SELL" ? "bg-loss text-white" : "bg-white/5"}`}
              >
                {translate('sell')}
              </button>
            </div>
              <label className="account-label">{translate('orderType')}<select className="input" required value={type} onChange={(event) => setType(event.target.value as "MARKET"|"LIMIT"|"STOP")}><option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option></select></label>
              <label className="account-label">{translate('quantity')}<input className="input" type="number" min="0.00000001" step="any" inputMode="decimal" required value={qty} onChange={(event) => setQty(event.target.value)} placeholder="0.00"/></label>
              {type !== "MARKET" && <label className="account-label">{type === "STOP" ? translate('stopPrice') : translate('limitPrice')}<input className="input" type="number" min="0.00000001" step="any" inputMode="decimal" required value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00"/></label>}
              <div className="trade-estimate" aria-live="polite"><div><span>{translate('availableDemoCash')}</span><b>{availableBalance===null?"Loading…":`$${availableBalance.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}</b></div><div><span>{translate('estimatedRequiredCash')}</span><b>{cur?`$${estimatedRequiredCash.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`:"—"}</b></div><div><span>{translate('estimatedFee')}</span><b>{cur?.takerFee===undefined?"Not configured":`$${estimatedFee.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4})}`}</b></div></div>
              <p className="trade-estimate-note">{translate('demoSpotOrders')}</p>
              <button type="submit" disabled={placing||!selected} className="btn w-full bg-gold text-black disabled:opacity-50">{placing?translate('submittingOrder'):translate('placeOrder',{side})}</button>
              </fieldset>
              {msg&&<p className="text-sm muted" role="status">{msg}</p>}
            </form>
            <div className="mt-6">
              <h3 className="font-bold">Open orders</h3>
              {orders.filter((o) => o.status === "OPEN").length ? (
                orders
                  .filter((o) => o.status === "OPEN")
                  .map((o) => (
                    <div
                      key={o.id}
                      className="flex justify-between border-b border-white/10 py-2 text-xs"
                    >
                      <span>
                        {o.instrument.symbol} {o.side} {o.type}
                      </span>
                      <button type="button" onClick={() => cancel(o.id)} className="gold">
                        {translate('cancel')}
                      </button>
                    </div>
                  ))
              ) : (
                <p className="mt-2 muted text-sm">{translate('noOpenOrders')}</p>
              )}
            </div>
          </section>
        </div>
        <section className="card mt-4 p-5">
          <div className="account-panel-title"><div><h2>{translate('openPositions')}</h2><p className="account-panel-subtitle">{translate('unrealizedPnl')}</p></div><span className="status-pill">{positions.length} open</span></div>
          {positions.length ? (
            <div className="mt-3 space-y-2">
              {positions.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-3"
                >
                  <span>
                    {p.instrument.symbol} · {p.side} · {p.quantity}
                  </span>
                  <span className={pnl(p) >= 0 ? "text-profit" : "text-loss"}>
                    {pnl(p) >= 0 ? "+" : ""}${pnl(p).toFixed(2)}
                  </span>
                  <button type="button" className="btn bg-loss" onClick={() => close(p.id)}>
                    {translate('close')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 muted">{translate('noOpenPositions')}</p>
          )}
        </section>
        <section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>{translate('orderHistory')}</h2><p className="account-panel-subtitle">{translate('recentSubmittedOrders')}</p></div><RefreshCw size={17} className="gold" aria-hidden="true"/></div>
          {orders.length?<div className="account-table-wrap"><table className="account-table"><thead><tr><th>Instrument</th><th>Side</th><th>Type</th><th>Quantity</th><th>Limit / stop</th><th>Status</th></tr></thead><tbody>{orders.slice(0,20).map(order=><tr key={order.id}><td>{order.instrument.symbol}</td><td>{order.side}</td><td>{order.type}</td><td>{Number(order.quantity).toLocaleString()}</td><td>{order.type==='LIMIT'?Number(order.price||0).toLocaleString(undefined,{maximumFractionDigits:6}):order.type==='STOP'?Number(order.stopPrice||0).toLocaleString(undefined,{maximumFractionDigits:6}):translate('market')}</td><td><span className="status-pill">{order.status.replaceAll('_',' ')}</span></td></tr>)}</tbody></table></div>:<div className="account-empty">{translate('noOrdersRecorded')}</div>}
        </section>
        </>:<div className="account-empty" role="status">{translate('restoringAccountSession')}</div>}
      </main>
    </>
  );
}
