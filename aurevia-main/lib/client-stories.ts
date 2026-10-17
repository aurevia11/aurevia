import {ClientStoryStatus} from '@prisma/client';
import {db} from '@/lib/db';
import {isVerifiedClientWithdrawal,publicWithdrawalAmount} from '@/lib/client-stories-policy';
import {resolveClientStoryImage} from '@/lib/client-story-media';
import {createPrivateSignedUrl} from '@/lib/private-storage';

export async function getPublishedClientStories(){
	const stories=await db.clientStory.findMany({
		where:{publicationStatus:ClientStoryStatus.PUBLISHED,verifiedClient:true,transactionVerified:true,consentConfirmed:true,userId:{not:null},deletedAt:null},
		include:{withdrawal:{select:{id:true,userId:true,type:true,accountMode:true,status:true,amount:true,currency:true,settlementReference:true,settledAt:true}}},
		orderBy:{updatedAt:'desc'},
		take:100,
	});
	return Promise.all(stories.filter(story=>{
		const withdrawal=story.withdrawal;
		return Boolean(withdrawal&&isVerifiedClientWithdrawal(withdrawal,story.userId)&&story.withdrawalAmount?.equals(withdrawal.amount)&&story.currency===withdrawal.currency);
	}).map(async story=>{
		const withdrawal=story.withdrawal!;
		const amount=publicWithdrawalAmount({show:story.showWithdrawalAmount,displayCurrency:story.displayCurrency,currency:withdrawal.currency,amount:withdrawal.amount.toString(),amountMatches:Boolean(story.withdrawalAmount?.equals(withdrawal.amount))});
		let imageUrl=resolveClientStoryImage(story.imageReference);
		if(story.imageReference?.startsWith('storage://client-stories/')){
			const key=story.imageReference.slice('storage://client-stories/'.length);
			imageUrl=await createPrivateSignedUrl('clientStory',story.id,key).catch(()=>null);
		}
		return {
			id:story.id,
			displayName:story.displayName,
			country:story.country,
			cityOrRegion:story.cityOrRegion,
			quote:story.quote,
			imageReference:story.imageReference,
			imageUrl,
			verifiedClientStory:true as const,
			...(amount?{withdrawalAmount:amount.amount,currency:amount.currency}:{}),
		};
	}));
}