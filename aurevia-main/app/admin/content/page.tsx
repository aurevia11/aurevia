import {redirect} from 'next/navigation';
import ClientStoriesPanel from '@/components/ClientStoriesPanel';
import AdminNav from '@/components/AdminNav';
import {requireAdmin} from '@/lib/auth';

export default async function AdminContentPage(){
	try{await requireAdmin()}catch{redirect('/admin/login')}
	return <><AdminNav/><main className="account-page"><header className="account-heading"><div><span className="account-kicker">WORKSPACE · CONTENT</span><h1>Client stories</h1><p>Review story drafts, verification, transaction evidence, consent, and publication.</p></div></header><ClientStoriesPanel/></main></>;
}
