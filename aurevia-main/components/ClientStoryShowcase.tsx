'use client';

import {useEffect,useState} from 'react';
import Image from 'next/image';
import Link from 'next/link';

type ClientStory={id:string;displayName:string;country:string;cityOrRegion:string|null;quote:string;imageUrl:string|null;withdrawalAmount?:string;currency?:string};

export default function ClientStoryShowcase(){
	const [stories,setStories]=useState<ClientStory[]>([]);
	useEffect(()=>{
		let active=true;
		void fetch('/api/client-stories',{cache:'no-store'}).then(async response=>{
			if(!response.ok)return [];
			const result=await response.json();
			return Array.isArray(result)?result as ClientStory[]:[];
		}).then(result=>{if(active)setStories(result.slice(0,3))}).catch(()=>undefined);
		return ()=>{active=false};
	},[]);
	if(!stories.length)return null;
	return <section className="home-section" aria-labelledby="client-stories-heading">
		<div className="section-heading"><div><p className="eyebrow">VERIFIED CLIENT STORIES</p><h2 id="client-stories-heading">Client stories</h2></div><Link className="text-link" href="/client-stories">View all stories</Link></div>
		<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{stories.map(story=><article key={story.id} className="card min-w-0 p-4 sm:p-5">
			{story.imageUrl&&<Image src={story.imageUrl} alt={`Portrait for ${story.displayName}'s verified story`} width={320} height={320} unoptimized className="mb-4 aspect-square w-20 rounded-md object-cover"/>}
			<blockquote className="whitespace-pre-line break-words leading-7">{story.quote}</blockquote>
			<div className="mt-4 border-t border-white/10 pt-3"><h3 className="font-semibold">{story.displayName}</h3><p className="muted text-sm">{[story.cityOrRegion,story.country].filter(Boolean).join(', ')}</p>
				{story.withdrawalAmount&&<p className="mt-2 text-sm">Verified withdrawal · {Number(story.withdrawalAmount).toLocaleString()} {story.currency}</p>}
			</div>
		</article>)}</div>
	</section>;
}