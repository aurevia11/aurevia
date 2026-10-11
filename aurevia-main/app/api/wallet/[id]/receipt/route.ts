import {NextResponse} from 'next/server';
import {FundingStatus,FundingType,NotificationType} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {sendSupportEmail} from '@/lib/email';
import {createPrivateObjectKey,createPrivateSignedUrl,deletePrivateObject,hasMatchingFileExtension,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';

const maxUploadBytes=5*1024*1024;
const reviewableStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.PROCESSING];
const fileTypes={pdf:{mime:'application/pdf',extension:'pdf'},png:{mime:'image/png',extension:'png'},jpeg:{mime:'image/jpeg',extension:'jpg'},webp:{mime:'image/webp',extension:'webp'}} as const;
type ReceiptFormat=keyof typeof fileTypes;

function detectFormat(bytes:Buffer):ReceiptFormat|null{
	if(bytes.subarray(0,5).toString()==='%PDF-')return 'pdf';
	if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
	if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'jpeg';
	if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'webp';
	return null;
}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
	let newKey:string|undefined;
	let ownerId:string|undefined;
	try{
		const {id}=await params;
		const user=await requireUser();
		ownerId=user.id;
		const contentLength=Number(request.headers.get('content-length')||0);
		if(contentLength>maxUploadBytes+64*1024)return NextResponse.json({error:'Receipt must be 5 MB or smaller.'},{status:413});
		const form=await request.formData();
		const file=form.get('file');
		if(!(file instanceof File)||file.size===0||file.size>maxUploadBytes)return NextResponse.json({error:'Choose a non-empty receipt file no larger than 5 MB.'},{status:400});
		const requestRow=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:user.accountMode,type:FundingType.DEPOSIT,status:{in:reviewableStatuses}},select:{id:true,userId:true,accountMode:true,amount:true,currency:true,status:true,receiptKey:true}});
		if(!requestRow)return NextResponse.json({error:'Pending deposit request not found.'},{status:404});
		const bytes=Buffer.from(await file.arrayBuffer());
		const format=detectFormat(bytes);
		if(!format||fileTypes[format].mime!==file.type||!hasMatchingFileExtension(file.name,fileTypes[format].mime))return NextResponse.json({error:'Receipt must be a valid PDF, PNG, JPEG, or WebP file with a matching extension.'},{status:415});
		const receiptKey=createPrivateObjectKey('receipt',user.id,fileTypes[format].mime);
		newKey=receiptKey;
		await uploadPrivateObject('receipt',user.id,receiptKey,bytes,fileTypes[format].mime);
		const updated=await db.$transaction(async tx=>{
			const claimed=await tx.fundingRequest.updateMany({where:{id:requestRow.id,userId:user.id,type:FundingType.DEPOSIT,status:{in:reviewableStatuses}},data:{receiptKey}});
			if(claimed.count!==1)throw new Error('RECEIPT_REQUEST_CHANGED');
			await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_RECEIPT_UPLOADED',entity:'FUNDING',entityId:requestRow.id,metadata:{accountMode:requestRow.accountMode,fileType:fileTypes[format].mime,fileSize:bytes.length}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.DEPOSIT,title:'Payment receipt received',message:'Your receipt is stored privately and is awaiting administrator review. Funds have not been credited.',dedupeKey:`funding:${requestRow.id}:receipt:${receiptKey.split('/').at(-1)}`,relatedEntity:'FUNDING',relatedId:requestRow.id,actionUrl:`/wallet/transactions/${requestRow.id}`});
			await notifyActiveAdmins(tx,{type:NotificationType.DEPOSIT,title:'Payment receipt uploaded',message:`A deposit receipt for a ${requestRow.accountMode.toLowerCase()} request awaits review.`,dedupeKey:`funding:${requestRow.id}:receipt-admin:${receiptKey.split('/').at(-1)}`,relatedEntity:'FUNDING',relatedId:requestRow.id,actionUrl:'/admin'});
			return {previousKey:requestRow.receiptKey};
		});
		if(updated.previousKey)await deletePrivateObject('receipt',user.id,updated.previousKey);
		const delivery=await sendSupportEmail('Payment receipt uploaded',`Funding request ${requestRow.id} has a receipt awaiting review. The receipt remains private and must be reviewed in the admin dashboard.`);
		return NextResponse.json({ok:true,receiptUploaded:true,fundsCredited:false,emailDelivery:delivery.sent?'sent':delivery.reason||'failed'},{status:201});
	}catch(error){
		if(newKey&&ownerId)await deletePrivateObject('receipt',ownerId,newKey);
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to upload a receipt.'},{status:401});
		if(error instanceof Error&&error.message==='RECEIPT_REQUEST_CHANGED')return NextResponse.json({error:'The funding request changed. Refresh and try again.'},{status:409});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		console.error('Payment receipt upload failed.');
		return NextResponse.json({error:'Receipt upload is temporarily unavailable.'},{status:503});
	}
}

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const user=await requireUser();
		const funding=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:user.accountMode},select:{userId:true,receiptKey:true}});
		if(!funding)return NextResponse.json({error:'Funding request not found.'},{status:404});
		if(!funding.receiptKey)return NextResponse.json({error:'No receipt is attached to this request.'},{status:404});
		return NextResponse.json({url:await createPrivateSignedUrl('receipt',funding.userId,funding.receiptKey)},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		return NextResponse.json({error:'Receipt is unavailable.'},{status:503});
	}
}