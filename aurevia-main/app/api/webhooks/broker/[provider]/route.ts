import {NextResponse} from 'next/server';
import {getExecutionProviderStatus,getExecutionProvider} from '@/lib/providers/registry';

export const dynamic='force-dynamic';

export async function POST(request:Request,{params}:{params:Promise<{provider:string}>}){
	const {provider:providerName}=await params;
	const status=await getExecutionProviderStatus();
	const provider=getExecutionProvider();
	if(!provider||!status.enabled||status.state!=='CONNECTED'||provider.name!==providerName){
		return NextResponse.json({error:'Broker webhook processing is unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
	const rawBody=await request.text();
	const signature=request.headers.get('x-provider-signature')||'';
	try{
		if(!await provider.verifyWebhook(rawBody,signature)){
			return NextResponse.json({error:'Invalid webhook signature.'},{status:401,headers:{'Cache-Control':'no-store'}});
		}
		const event=await provider.parseWebhook(rawBody);
		if(!event.eventId||!event.eventType||!event.providerOrderId||!Number.isFinite(Date.parse(event.occurredAt))){
			return NextResponse.json({error:'Invalid provider event.'},{status:400,headers:{'Cache-Control':'no-store'}});
		}
		return NextResponse.json({
			error:'Verified event persistence and order reconciliation are not enabled until a provider-specific adapter is implemented.',
			eventId:event.eventId,
		},{status:503,headers:{'Cache-Control':'no-store'}});
	}catch{
		return NextResponse.json({error:'Provider webhook could not be verified or parsed.'},{status:400,headers:{'Cache-Control':'no-store'}});
	}
}
