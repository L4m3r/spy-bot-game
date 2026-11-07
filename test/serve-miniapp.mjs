// Local-only UI integration fixture. Never imported by or deployed with the Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHmac } from 'node:crypto';
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const bundle = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, format: 'esm', target: 'es2022', platform: 'browser', external: ['cloudflare:workers','node:*'], write: false });
const token = '999:local-fixture-not-a-real-token';
let messageId = 1;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  durableObjects: { ROOMS: { className:'GameRoom', useSQLite:true }, USER_LIMITS: { className:'UserLimits', useSQLite:true } },
  bindings: { BOT_TOKEN: token, WEBHOOK_SECRET: 'local_fixture_secret' },
  outboundService: async request => {
    const method = new URL(request.url).pathname.split('/').at(-1);
    const data = await request.json();
    let response;
    if (method === 'getMe') response = { ok:true, result:{ id:999, is_bot:true, first_name:'Шпион', username:'test_spy_bot' } };
    else if (method === 'sendMessage' && data.chat_id === 2 && data.text?.startsWith('Раунд ')) response = { ok:false, error_code:403, description:'Test notification failure' };
    else response = { ok:true, result:{ message_id:++messageId, date:1, chat:{ id:data.chat_id,type:'private' }, text:data.text } };
    return Response.json(response, { status:response.ok ? 200 : 403 });
  },
});
const staticFiles = new Map([['/miniapp/',['index.html','text/html']],['/miniapp/app.js',['app.js','text/javascript']],['/miniapp/app.css',['app.css','text/css']]]);
const server = createServer(async (request,response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:8795');
    if (url.pathname.startsWith('/api/')) {
      const chunks=[];for await (const chunk of request) chunks.push(chunk);
      const result = await mf.dispatchFetch(url.href, { method:request.method,headers:request.headers,body:request.method==='POST' ? Buffer.concat(chunks):undefined });
      response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));return;
    }
    const entry=staticFiles.get(url.pathname);
    if (!entry) {response.writeHead(404);response.end('Not found');return;}
    let body=await readFile(new URL('../dist/miniapp/'+entry[0],import.meta.url));
    const id=Number(url.searchParams.get('test_user'));
    if (entry[0]==='index.html' && [1,2,3,4].includes(id)) {
      const user={id,first_name:['','Алексей','Мария','Денис','Кира'][id]};
      const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify(user)});
      const data=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
      const secret=createHmac('sha256','WebAppData').update(token).digest();
      params.set('hash',createHmac('sha256',secret).update(data).digest('hex'));
      const mock={initData:params.toString(),colorScheme:url.searchParams.get('theme')==='light'?'light':'dark',themeParams:{}};
      const sdk=`<script>window.Telegram={WebApp:${JSON.stringify(mock)}};Object.assign(window.Telegram.WebApp,{isVersionAtLeast:()=>false,ready(){},expand(){},onEvent(){}});</script>`;
      body=Buffer.from(body.toString().replace('<script src="https://telegram.org/js/telegram-web-app.js" defer></script>',sdk));
    }
    response.writeHead(200,{'Content-Type':entry[1]+'; charset=utf-8','Cache-Control':'no-store'});response.end(body);
  } catch {response.writeHead(500);response.end('Local fixture failed');}
});
server.listen(8795,'127.0.0.1',()=>console.log('Local fixture (fictional users, mocked Telegram): http://127.0.0.1:8795/miniapp/?test_user=1'));
process.on('SIGINT',async()=>{server.close();await mf.dispose();process.exit(0);});
