import next from 'next';
import {createServer} from 'http';
import {Server as IOServer} from 'socket.io';
import {loadEnvConfig} from '@next/env';
import {tickMarkets} from './lib/market';
import {createIndividualTradingApiProviderFromEnvironment} from './lib/providers/alpaca-crypto-provider';
import {registerExecutionProvider} from './lib/providers/registry';
import {getServerConfiguration} from './lib/config/env';

loadEnvConfig(process.cwd());
const tradingProvider=createIndividualTradingApiProviderFromEnvironment();
if(tradingProvider)registerExecutionProvider(tradingProvider,{executionEnabled:getServerConfiguration().execution.realEnabled&&tradingProvider.executionMode==='LIVE'});

const dev=process.env.NODE_ENV!=='production';
const port=Number(process.env.PORT||3000);
const app=next({dev});
const handle=app.getRequestHandler();
const configuredPublicUrl=process.env.NEXT_PUBLIC_APP_URL||process.env.NEXTAUTH_URL;
const publicUrl=configuredPublicUrl||`http://localhost:${port}`;

function safeErrorCode(error:unknown){
 const value=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 return /^[A-Z0-9_]{2,32}$/.test(value)?value:error instanceof Error?error.name:'UnknownError';
}

async function startServer(){
 if(!dev){
  const missing=['NEXTAUTH_SECRET','NEXTAUTH_URL'].filter(name=>!process.env[name]?.trim());
  if(missing.length){
   console.error(`Missing required production configuration: ${missing.join(', ')}`);
   process.exit(1);
  }
  for(const [name,value] of [['NEXTAUTH_URL',process.env.NEXTAUTH_URL],['NEXT_PUBLIC_APP_URL',configuredPublicUrl]] as const){
   if(!value)continue;
   try{new URL(value)}catch{
    console.error(`${name} must be an absolute URL in production.`);
    process.exit(1);
   }
  }
 }
 try{
  await app.prepare();
 }catch(error){
  console.error('Next.js preparation failed; startup aborted', error);
  process.exit(1);
 }

 const http=createServer((req,res)=>handle(req,res));
 const io=new IOServer(http,{cors:{origin:publicUrl,credentials:true}});
 io.on('connection',socket=>{socket.emit('connected',{ok:true});});
     const intervalMs=Math.max(1000,Number(process.env.MARKET_TICK_MS||2500));
 let running=false;
 let consecutiveFailures=0;

 http.once('error',(error:NodeJS.ErrnoException)=>{
  console.error(error.code==='EADDRINUSE'?'Configured HTTP port is already in use':'HTTP server failed to start');
  process.exit(1);
 });

 http.listen(port,()=>{
  console.log('Aurevia Invest HTTP server listening');
    const runMarketTick=async()=>{
     if(running)return scheduleNextTick(intervalMs);
   running=true;
     let nextDelay=intervalMs;
   try{
    const data=await tickMarkets();
        consecutiveFailures=0;
    io.emit('market:update',data);
     }catch(error){
        consecutiveFailures++;
        nextDelay=Math.min(intervalMs*2**Math.min(consecutiveFailures,6),60_000);
        console.error(`Market tick failed; retrying in ${nextDelay}ms (attempt ${consecutiveFailures}, ${safeErrorCode(error)}).`);
   }finally{
    running=false;
        scheduleNextTick(nextDelay);
   }
    };
    function scheduleNextTick(delay:number){setTimeout(()=>{void runMarketTick()},delay)}
    scheduleNextTick(0);
 });
}

void startServer();
