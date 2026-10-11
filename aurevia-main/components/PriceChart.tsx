'use client';
import {useEffect,useState} from 'react';
import {LineChart,Line,XAxis,YAxis,Tooltip,ResponsiveContainer} from 'recharts';
type P={t:number;p:number};
export default function PriceChart({price,instrumentId,limit=40}:{price:number;instrumentId?:string;limit?:number}){
	const [data,setData]=useState<P[]>([]);
	useEffect(()=>{
		if(!instrumentId)return;
		let active=true;
		fetch(`/api/candles?instrumentId=${encodeURIComponent(instrumentId)}&limit=${limit}`,{cache:'no-store'}).then(async response=>{
			if(!response.ok)throw new Error('Candle data unavailable.');
			return response.json();
		}).then((candles:Array<{ts:string;close:string|number}>)=>{
			if(active)setData(candles.map(candle=>({t:new Date(candle.ts).getTime(),p:Number(candle.close)})));
		}).catch(()=>{if(active)setData([])});
		return()=>{active=false};
	},[instrumentId,limit]);
	useEffect(()=>setData(current=>[...current.slice(-(limit-1)),{t:Date.now(),p:price}]),[price,limit]);
	return <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><XAxis dataKey="t" hide/><YAxis domain={['auto','auto']} tick={{fill:'#aaa'}} width={70}/><Tooltip formatter={value=>Number(value).toLocaleString(undefined,{maximumFractionDigits:6})}/><Line type="monotone" dataKey="p" dot={false} strokeWidth={2}/></LineChart></ResponsiveContainer></div>;
}
