const http=require('node:http');
const codes=new Map();
const counts={email:0,sms:0};

const server=http.createServer((request,response)=>{
	const url=new URL(request.url||'/',`http://${request.headers.host||'127.0.0.1'}`);
	if(request.method==='GET'&&url.pathname==='/health'){
		response.writeHead(200,{'content-type':'application/json'});
		response.end('{"ok":true}');
		return;
	}
	if(request.method==='POST'&&url.pathname==='/reset'){
		counts.email=0;counts.sms=0;codes.clear();
		response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');return;
	}
	if(request.method==='GET'&&url.pathname==='/stats'){
		response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(counts));return;
	}
	if(request.method==='POST'&&(url.pathname==='/email'||url.pathname==='/sms')){
		let body='';
		request.on('data',chunk=>body+=chunk);
		request.on('end',()=>{
			try{
				const payload=JSON.parse(body);
				const code=String(payload.text||'').match(/code is (\d{6})/)?.[1];
				if(!code||typeof payload.to!=='string')throw new Error('invalid test delivery payload');
				counts[url.pathname==='/sms'?'sms':'email']++;
				codes.set(payload.to,code);
				response.writeHead(202,{'content-type':'application/json'});
				response.end('{}');
			}catch{
				response.writeHead(400,{'content-type':'application/json'});
				response.end('{"error":"invalid test delivery payload"}');
			}
		});
		return;
	}
	if(request.method==='GET'&&url.pathname==='/test-code'){
		const code=codes.get(url.searchParams.get('email')||'');
		if(!code){response.writeHead(404);response.end();return;}
		response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
		response.end(JSON.stringify({code}));
		return;
	}
	response.writeHead(404);
	response.end();
});

server.listen(4311,'127.0.0.1');
