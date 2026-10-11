import {withAuth} from 'next-auth/middleware';

export default withAuth({callbacks:{authorized:({token,req})=>{
	const path=req.nextUrl.pathname;
	if(path==='/admin/login')return true;
	if(path.startsWith('/admin'))return token?.role==='ADMIN';
	return !!token;
}}});

export const config={matcher:['/dashboard/:path*','/trade/:path*','/portfolio/:path*','/orders/:path*','/investments/:path*','/wallet/:path*','/kyc/:path*','/settings/:path*','/notifications/:path*','/admin/:path*']};