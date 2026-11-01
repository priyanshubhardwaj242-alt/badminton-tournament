// Robustness fuzzer: sends ~10,000 malformed requests to every API route and reports any server error (HTTP 5xx).
// Usage: npm run fuzz   (uses a temporary in-memory database; touches none of your data)
const path=require('node:path'), P=path.join(__dirname,'..')+path.sep;
const { boot, setupCategory, soon } = require(P+'tests/helpers'); const { createApp } = require(P+'src/server');
(async()=>{
  const t = await boot(); t.mkUser('admin1','admin'); const admin = await t.client().login('admin1');
  const a = await setupCategory(admin, 6, {third:true}); const rr = (await admin('POST','/api/categories',{name:'RR cat',kind:'singles',format:'roundrobin',published:true})).body.id;
  const { routes } = createApp(t.db, {});
  const ids=['1','2','999999','abc','-1','0','1e9','1.5','%00','1%20OR%201=1'];
  const bodies=[{}, {x:1}, {name:null}, {name:'x'.repeat(5000)}, {side:'a'}, {side:{}}, {winner:'a',reason:'because'}, {games:'x'}, {games:[{a:'z',b:null}]}, {games:[{a:21,b:1},{a:21,b:2}],reason:'fuzz'}, {court_id:'1',scheduled_at:'nope'}, {court_id:1,scheduled_at:'2026-13-45'}, {court_id:{},scheduled_at:{}},
    {status:5}, {status:'approved'}, {seed:'abc'}, {category_id:'x',team_a:1,team_b:1}, {category_id:a.cat,team_a:1,team_b:2,round:'zz'}, {username:{}, password:[]}, {username:'ab'.repeat(40),password:'x'}, {rules:{games_to_win:'x'}}, {rules:null}, {match_minutes:-5},
    {player:null,category_ids:'x'}, {player:{name:'Zed Fuzz',gender:'male',college_id:'F1'},category_ids:[a.cat,'x',null]}, {published:'yes',kind:'doubles',gender:'mixed',format:'roundrobin',groups:99,name:'Fuzz category'}, {client_id:{},side:'a'}, {version:'abc'}, {note:5,reason:{}}, [], 'str', null, 123];
  const queries=['', '?category=abc','?category=1&court=%00&status=%27;--&q=%25','?before=abc','?unscheduled=1&q='+'a'.repeat(300),'?status=live&category=-1','?limit=-1'];
  const bad=[]; let n=0;
  const raw=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${t.port}${path}`,{method,headers:{'Content-Type':'application/json',Cookie:await cookie()},body:body===undefined||method==='GET'?undefined:(typeof body==='string'&&body.startsWith('{')?body:JSON.stringify(body))});const x=await r.text();return {status:r.status,text:x,ct:r.headers.get('content-type')};};
  let ck=null; const cookie=async()=>{ if(ck) return ck; const r=await fetch(`http://127.0.0.1:${t.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin1',password:'correct-horse-battery'})}); ck=r.headers.getSetCookie()[0].split(';')[0]; return ck; };
  const skip=/events|logout|\/auth\/password/;
  for(const r of routes){ const src=r.re.source; if(skip.test(src)) continue;
    const pattern=src.replace(/^\^|\$$/g,'').replace(/\(\?<(\w+)>\[\^\/\]\+\)/g,':$1').replace(/\\\//g,'/').replace(/\\\./g,'.');
    const pathsets = pattern.includes(':') ? ids.map(i=>pattern.replace(/:\w+/g, pattern.includes('export')?'players':i)) : [pattern];
    for(const path of [...new Set(pathsets)]){
      const variants = r.method==='GET' ? queries.map(q=>[path+q,undefined]) : bodies.map(b=>[path,b]);
      for(const [p,b] of variants){ n++; let res; try{ res=await raw(r.method,p,b);}catch(e){ bad.push(`${r.method} ${p} threw ${e.message}`); continue;}
        if(res.status>=500) bad.push(`${res.status} ${r.method} ${p} body=${JSON.stringify(b)} -> ${res.text.slice(0,100)}`);
        else if(res.ct&&res.ct.includes('json')){ try{JSON.parse(res.text);}catch{bad.push(`bad json ${r.method} ${p}`);} } } } }
  // malformed transport-level inputs
  for(const [m,p,b,h] of [['POST','/api/auth/login','{bad json',{}],['GET','/%E0%A4%A','',{}],['GET','/..%2f..%2fsrc/db.js','',{}],['POST','/api/categories','{}',{Origin:'null'}],['POST','/api/categories','{}',{Origin:'not a url'}],['PUT','/api/health','{}',{}],['GET','/api/public/matches?category[]=1&category[]=2','',{}]]){
    n++; const r=await fetch(`http://127.0.0.1:${t.port}${p}`,{method:m,headers:{'Content-Type':'application/json',Cookie:await cookie(),...h},body:m==='GET'?undefined:b}); if(r.status>=500) bad.push(`${r.status} ${m} ${p} ${JSON.stringify(h)}`); }
  console.log(`requests: ${n}, server errors: ${bad.length}`); const seen=new Set(),u=[];for(const x of bad){const k=x.split(" body=")[0].replace(/\/\d+|\/[a-z%0-9]+$/,"");if(!seen.has(k)){seen.add(k);u.push(x.slice(0,230));}}console.log(u.join("\n")); await t.close(); process.exit(0);
})();
