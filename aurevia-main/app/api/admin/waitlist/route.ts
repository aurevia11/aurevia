import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {sendEmail,isSmtpConfigured} from '@/lib/email';
import {waitlistStatusSchema} from '@/lib/waitlist';

export const dynamic='force-dynamic';

export async function GET(){
  try{
    await requireAdmin();
    const entries=await db.waitlistEntry.findMany({include:{user:{select:{id:true,email:true,name:true}}},orderBy:{createdAt:'desc'},take:1000});
    return NextResponse.json(jsonSafe(entries),{headers:{'Cache-Control':'private, no-store'}});
  }catch{return NextResponse.json({error:'Forbidden'},{status:403})}
}

export async function PATCH(request:Request){
  try{
    const admin=await requireAdmin();
    const input=waitlistStatusSchema.parse(await request.json());
    const current=await db.waitlistEntry.findUnique({where:{id:input.id}});
    if(!current)return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    const updated=await db.$transaction(async tx=>{
      const entry=await tx.waitlistEntry.update({where:{id:input.id},data:{status:input.status,notes:input.notes??null,updatedAt:new Date()}});
      await tx.auditLog.create({data:{actorId:admin.id,action:`WAITLIST_STATUS_${input.status}`,entity:'WAITLIST_ENTRY',entityId:input.id,metadata:{status:input.status,notes:input.notes||null}}});
      if(input.status==='INVITED'&&isSmtpConfigured()&&current.email){
        const delivery=await sendEmail({to:current.email,subject:'Aurevia waitlist invitation',text:'Your Aurevia waitlist status was updated to INVITED. This message confirms the administrative status update and does not grant account access, trading privileges, KYC approval, or broker authorization.'});
        if(!delivery.sent)throw new Error('INVITATION_DELIVERY_FAILED');
      }
      return entry;
    });
    return NextResponse.json({entry:jsonSafe(updated),delivery:input.status==='INVITED'&&isSmtpConfigured()?'sent':'not-configured'});
  }catch(error){
    if(error instanceof ZodError)return NextResponse.json({error:'Invalid waitlist update.'},{status:400});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    return NextResponse.json({error:error instanceof Error&&error.message==='INVITATION_DELIVERY_FAILED'?'Invitation status updated. Email delivery failed.':'Unable to update the waitlist entry.'},{status:400});
  }
}

export async function DELETE(request:Request){
  try{
    const admin=await requireAdmin();
    const id=(await request.json()).id;
    if(!id)return NextResponse.json({error:'Waitlist entry ID is required.'},{status:400});
    const entry=await db.waitlistEntry.findUnique({where:{id}});
    if(!entry)return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    await db.$transaction(async tx=>{
      await tx.auditLog.create({data:{actorId:admin.id,action:'WAITLIST_ENTRY_REMOVED',entity:'WAITLIST_ENTRY',entityId:id,metadata:{email:entry.email}}});
      await tx.waitlistEntry.delete({where:{id}});
    });
    return NextResponse.json({removed:true});
  }catch(error){
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    return NextResponse.json({error:'Unable to remove the waitlist entry.'},{status:400});
  }
}
