import {getServerSession} from 'next-auth'; import {authOptions} from '@/lib/auth-options';
export async function requireUser(){const s=await getServerSession(authOptions); if(!s?.user?.id) throw new Error('UNAUTHORIZED'); return s.user;}
export async function requireAdmin(){const u=await requireUser(); if(u.role!=='ADMIN') throw new Error('FORBIDDEN'); return u;}
