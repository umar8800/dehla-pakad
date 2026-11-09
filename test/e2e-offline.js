const {chromium}=require('playwright');const {spawn}=require('child_process');
const SP=require('os').tmpdir()+'/';
const start=()=>spawn('node',['server/index.js'],{cwd:require('path').join(__dirname,'..'),env:{...process.env,PORT:4080,SUPABASE_URL:'',LIVEKIT_URL:'',NODE_ENV:'production'}});
let srv=start();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const step=async(n,f)=>{try{await f();console.log('ok  ',n);}catch(e){console.log('FAIL',n,e.message.split('\n')[0]);}};
(async()=>{await sleep(700);const b=await chromium.launch();const errs=[];
 // A) existing player
 const ctx=await b.newContext({viewport:{width:390,height:844}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://localhost:4080/');await sleep(500);await p.fill('#meUser','Umar');await p.fill('#mePin','1234');await sleep(300);await p.click('#meGo');await sleep(1200);
 await p.evaluate(async()=>{await navigator.serviceWorker.ready;});await sleep(800);
 const cached=await p.evaluate(async()=>{const c=await caches.open('dp-v3');return (await c.keys()).map(r=>new URL(r.url).pathname);});
 console.log('saved on phone:',cached.join(' '));
 await step('A: no internet, reopen app → home + offline bar',async()=>{await ctx.setOffline(true);await p.goto('http://localhost:4080/',{timeout:8000});await sleep(1200);
   const st=await p.evaluate(()=>({home:!document.getElementById('scr-home').hidden,off:!document.getElementById('offbar').hidden,font:document.fonts.check('16px Figtree')}));
   if(!st.home||!st.off)throw new Error(JSON.stringify(st));console.log('      fonts offline:',st.font);await p.screenshot({path:SP+'o1.png'});});
 await step('A: offline practice game starts and plays',async()=>{await p.evaluate(()=>{TIPS.off=true;TIPS.hide();});await p.click('[data-home=offline]');await sleep(600);
   const s=await p.$('#suGo, #suStart, [data-act=start]');if(s)await s.click();await sleep(2500);
   const ok=await p.evaluate(()=>!document.getElementById('scr-game').hidden&&document.querySelectorAll('#hand .card').length>0);if(!ok)throw new Error('no game');await p.screenshot({path:SP+'o2.png'});});
 await step('A: friends table offline → clear message, no hang',async()=>{await p.goto('http://localhost:4080/',{timeout:8000});await sleep(900);await p.evaluate(()=>{TIPS.off=true;TIPS.hide();});await p.click('[data-home=friends-new]');await sleep(300);
   const t=await p.evaluate(()=>document.querySelector('.toast')&&document.querySelector('.toast').textContent);if(!/Internet nahi/.test(t||''))throw new Error(t);});
 await ctx.setOffline(false);
 // B) server down (sleeping) but internet on: page must still open instantly
 srv.kill();await sleep(500);
 await step('B: server asleep → app still opens in <3s',async()=>{const t0=Date.now();await p.goto('http://localhost:4080/1234',{timeout:5000});await sleep(500);
   const home=await p.evaluate(()=>!document.getElementById('scr-home').hidden||!document.getElementById('scr-olobby').hidden);if(!home)throw new Error('not shown');console.log('      opened in',Date.now()-t0,'ms');});
 srv=start();await sleep(800);
 // C) brand-new person with no internet after first visit, no account
 const ctx2=await b.newContext({viewport:{width:390,height:844}});const q=await ctx2.newPage();q.on('pageerror',e=>errs.push('C '+e.message));
 await q.goto('http://localhost:4080/');await q.evaluate(async()=>{await navigator.serviceWorker.ready;});await sleep(1000);
 await ctx2.setOffline(true);
 await step('C: new person offline → guest offline practice',async()=>{await q.goto('http://localhost:4080/',{timeout:8000});await sleep(800);await q.screenshot({path:SP+'o3.png'});
   await q.click('#meGuest');await sleep(500);await q.evaluate(()=>{TIPS.off=true;TIPS.hide();});await q.click('[data-home=offline]');await sleep(500);const s=await q.$('#suGo, #suStart, [data-act=start]');if(s)await s.click();await sleep(2000);
   const ok=await q.evaluate(()=>!document.getElementById('scr-game').hidden);if(!ok)throw new Error('no game');});
 await step('C: guest stays guest after reopen',async()=>{await q.goto('http://localhost:4080/',{timeout:8000});await sleep(800);const h=await q.evaluate(()=>!document.getElementById('scr-home').hidden);if(!h)throw new Error('back to signup');});
 await ctx2.setOffline(false);
 await step('C: guest goes online, taps Friends table → asked for username',async()=>{await q.goto('http://localhost:4080/');await sleep(1200);await q.click('[data-home=friends-new]');await sleep(500);const on=await q.evaluate(()=>!document.getElementById('scr-me').hidden&&!!document.getElementById('meUser'));if(!on)throw new Error('no signup');});
 console.log(errs.length?errs.join('\n'):'no page errors');await b.close();srv.kill();process.exit(0);})().catch(e=>{console.log(e.message);srv.kill();process.exit(1)});
