import {NextResponse} from 'next/server';
import {tickMarkets} from '@/lib/market';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;

export async function GET(request:Request){
	const secret=process.env.CRON_SECRET;
	if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`){
		return NextResponse.json({error:'Unauthorized'},{status:401,headers:{'Cache-Control':'no-store'}});
	}
	try{
		const updates=await tickMarkets();
		return NextResponse.json({ok:true,updated:updates.length},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		const code=error&&typeof error==='object'&&'code' in error&&/^[A-Z0-9_]{2,32}$/.test(String(error.code))?String(error.code):error instanceof Error?error.name:'UnknownError';
		console.error(`Scheduled market tick failed (${code}).`);
		return NextResponse.json({error:'Market tick unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
