import {ClientStoryStatus,FundingStatus,FundingType,AccountMode} from '@prisma/client';
import {db} from '@/lib/db';
import {isVerifiedClientWithdrawal,publicWithdrawalAmount} from '@/lib/client-stories-policy';

export async function getPublishedClientStories(){
	const stories=await db.clientStory.findMany({
		where:{publicationStatus:ClientStoryStatus.PUBLISHED,verifiedClient:true,transactionVerified:true,consentConfirmed:true,userId:{not:null}},
		include:{withdrawal:{select:{id:true,userId:true,type:true,accountMode:true,status:true,amount:true,currency:true,settlementReference:true,settledAt:true}}},
		orderBy:{updatedAt:'desc'},
		take:100,
	});
	return stories.filter(story=>{
		const withdrawal=story.withdrawal;
		return Boolean(withdrawal&&isVerifiedClientWithdrawal(withdrawal,story.userId)&&story.withdrawalAmount?.equals(withdrawal.amount)&&story.currency===withdrawal.currency);
	}).map(story=>{
		const withdrawal=story.withdrawal!;
		const amount=publicWithdrawalAmount({show:story.showWithdrawalAmount,displayCurrency:story.displayCurrency,currency:withdrawal.currency,amount:withdrawal.amount.toString(),amountMatches:Boolean(story.withdrawalAmount?.equals(withdrawal.amount))});
		return {
			id:story.id,
			displayName:story.displayName,
			country:story.country,
			cityOrRegion:story.cityOrRegion,
			quote:story.quote,
			imageReference:story.imageReference,
			verifiedClientStory:true as const,
			...(amount?{withdrawalAmount:amount.amount,currency:amount.currency}:{}),
		};
	});
}