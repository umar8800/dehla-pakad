/* ================= online friends tables ================= */
const NET={ws:null,state:null,imgs:[null,null,null,null],want:null,connected:false,retry:0,sel:null,resultKey:null,follow:true,pendingJoin:null,logs:[],promptFor:null,chromeKey:null,everConnected:false};
NET.pid=(()=>{let p=null;try{p=localStorage.getItem('dp-pid');}catch(e){}if(!p){p='p'+Math.random().toString(36).slice(2)+Date.now().toString(36);try{localStorage.setItem('dp-pid',p);}catch(e){}}return p;})();
function netConnect(){
  if(!APP.profile) return;
  if(NET.ws&&(NET.ws.readyState===0||NET.ws.readyState===1)) return;
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  NET.ws=ws;
  ws.onopen=()=>{NET.connected=true;NET.everConnected=true;NET.retry=0;$('netbar').hidden=true;
    ws.send(JSON.stringify({t:'hello',pid:NET.pid,name:APP.profile.name,icon:APP.profile.icon}));
    if(NET.want){ws.send(JSON.stringify(NET.want));NET.want=null;}};
  ws.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch(e){return;}netOnMessage(m);};
  ws.onclose=()=>{NET.connected=false;if(NET.state)$('netbar').hidden=false;setTimeout(netConnect,Math.min(8000,700*2**NET.retry++));};
}
function netSend(o){if(NET.ws&&NET.ws.readyState===1)NET.ws.send(JSON.stringify(o));else{NET.want=o;netConnect();if(NET.everConnected)toast('Server se jod rahe hain…');}}
const nRel=x=>NET.state?(x-NET.state.me+4)%4:x;
const nAbs=r=>NET.state?(r+NET.state.me)%4:r;
const nName=i=>{const st=NET.state,s=st&&st.seats[i];return i===(st&&st.me)?'Tum':(s?s.name:'?');};
const nNe=i=>i===(NET.state&&NET.state.me)?'Tumne':esc(nName(i))+' ne';
const nIcon=i=>{const s=NET.state&&NET.state.seats[i];if(!s)return '🙂';return s.icon==='img'?(NET.imgs[i]||'🙂'):s.icon;};
const nTeam=t=>{const st=NET.state,mt=st.me%2;return st.teamNames[t]||(t===mt?'Hum':'Woh');};

function netOnMessage(m){
  if(m.t==='hi'){ if(NET.pendingJoin){netSend({t:'join',code:NET.pendingJoin});NET.pendingJoin=null;} return; }
  if(m.t==='state'){
    const prev=NET.state;NET.state=m;
    if(NET.pendingJoin&&NET.pendingJoin!==m.code){const c=NET.pendingJoin;NET.pendingJoin=null;netSend({t:'join',code:c});}
    else NET.pendingJoin=null;
    if(!prev||prev.code!==m.code){NET.logs=[];NET.resultKey=null;NET.follow=true;}
    netRender();return;
  }
  if(m.t==='avatars'){NET.imgs=m.imgs.map(x=>x||null);if(NET.state)netRender();return;}
  if(m.t==='event'){netEvent(m.e);return;}
  if(m.t==='error'){toast(esc(m.text),'them');return;}
  if(m.t==='left'){NET.state=null;NET.follow=false;closeSheet();goHome();}
}

function netEvent(e){
  const st=NET.state;if(!st)return;
  const L=t=>{NET.logs.unshift(t);if(NET.logs.length>120)NET.logs.pop();};
  switch(e.t){
    case 'joined': if(e.p!==st.me) toast(`${esc(nName(e.p))} table pe aa gaya`); break;
    case 'left': toast(`${esc(nName(e.p))} ne table chhodi`,'them'); break;
    case 'gone': toast(`${esc(nName(e.p))} ka connection gaya. Timer chalta rahega.`,'them'); break;
    case 'back': if(e.p!==st.me) toast(`${esc(nName(e.p))} wapas aa gaya`); break;
    case 'botIn': toast(`${esc(nName(e.p))} ki jagah ab bot khelega`); break;
    case 'newGame': closeSheet(); NET.resultKey=null; toast(`Game ${e.no} shuru`); L(`Game ${e.no} shuru.`); break;
    case 'trump': G.trumpFresh=true; toast(`Turup decide hua: ${sn(e.s)} · ${nNe(e.p)} kiya`); L(`${nNe(e.p)} ${sn(e.s)} turup decide kiya.`); break;
    case 'auto': toast(`${e.p===st.me?'Tumhara':esc(nName(e.p))+' ka'} time khatam · auto-play ${cn(e.c)}`,'them'); L(`${esc(nName(e.p))}: auto-play ${cn(e.c)}`); break;
    case 'trick': L(`Haath ${e.no}: ${esc(nName(e.w))}`); break;
    case 'streak': L(`${esc(nName(e.p))} ko lagatar ek aur haath chahiye.`); break;
    case 'dealRest': L('Baaki patte baant diye.'); break;
    case 'dealOne': L('Turup abhi decide nahi hua. Sabko ek-ek patta aur.'); break;
    case 'capture': {
      const what=e.tens.length?e.tens.map(c=>'10'+SYM[c.s]).join(' '):'koi dehla nahi';
      L(`${nNe(e.w)} dher utha liya: ${e.n} patte (${what}).`);
      if(e.tens.length) toast(`${nNe(e.w)} ${e.tens.length===1?'dehla pakda':e.tens.length+' dehle pakde'}! ${what}`,(e.w%2)===(st.me%2)?'us':'them');
      const host=$('flyHost');let bk='';for(let i=0;i<Math.min(Math.max(1,Math.round(e.n/4)),6);i++)bk+=`<div class="bk" style="transform:translateY(${-i*2}px) rotate(${(i%3-1)*6}deg)"></div>`;
      host.innerHTML=`<div class="fly to-${nRel(e.w)}">${bk}</div>`;setTimeout(()=>host.innerHTML='',950);
      break;
    }
    case 'react': { const r=nRel(e.to); if(r===0) toast(`${esc(nName(e.p))}: ${esc(e.emoji)}`); else react(r,e.emoji); break; }
    case 'say': say(nRel(e.p),LINES[e.line]||''); break;
  }
}

function netRender(){
  const st=NET.state;if(!st)return;
  const onTable=!$('scr-olobby').hidden||!$('scr-game').hidden;
  if(st.phase==='lobby'){ renderOLobby(); if(NET.follow||onTable){closeSheet();show('scr-olobby');} return; }
  if(!(NET.follow||onTable)) return;
  onlineGame(st);
  if($('scr-game').hidden) show('scr-game');
  if(st.prompt!==null&&st.prompt!==undefined&&NET.promptFor!==st.prompt){
    NET.promptFor=st.prompt;
    openSheet(`<h2>${esc(nName(st.prompt))} khel nahi raha</h2><p>Lagatar 3 baar time khatam hua. Unki jagah bot bitha dein? Woh wapas aaye toh seat le sakte hain.</p>
      <button class="cta" data-act="bot" type="button">Haan, bot bithao</button><button class="cta ghost" data-act="no" type="button">Nahi, intezaar karo</button>`,
      {bot:()=>{closeSheet();netSend({t:'host',a:'replaceBot',seat:st.prompt});},no:()=>{closeSheet();netSend({t:'host',a:'dismissPrompt'});}});
  }
  if(st.prompt===null) NET.promptFor=null;
}

function onlineGame(st){
  const me=st.me,mt=me%2,T=st.table,S=st.settings;
  const names=[0,1,2,3].map(r=>esc(nName(nAbs(r)))),icons=[0,1,2,3].map(r=>nIcon(nAbs(r)));
  const holder=T&&T.kot.holder!==null?(T.kot.holder===mt?0:1):null;
  const cfg={online:true,names,icons,teamNames:[nTeam(mt),nTeam(1-mt)],crestIdx:[1,2],timer:true,voice:false,human:true,
    title:()=>`Friends ki table · DP-${st.code}`,
    sub:()=>`${S.lengthType==='games'?`Game ${Math.min(T.played+1,S.games)}/${S.games}`:'Time wali table'} · Kot: ${holder===null?'kisi ke paas nahi':esc(cfg.teamNames[holder])+' '+T.kot.n}`,
    kotFor:t=>holder===t?T.kot.n:0,
    center:()=>{let tl;if(S.lengthType==='games')tl={big:`${Math.min(T.played+1,S.games)}/${S.games}`,small:'Game'};
      else{const left=Math.max(0,S.minutes*60000-T.elapsed-(Date.now()-NET.stateAt));tl={big:`${Math.floor(left/60000)}:${String(Math.floor(left%60000/1000)).padStart(2,'0')}`,small:`Baaki<br>Game ${T.played+1}`};}
      if(S.showDehle)tl.small+=`<br>${T.dehle[mt]}:${T.dehle[1-mt]} pts`;return tl;},
    onLeave:()=>openSheet(`<h2>Table chhodna hai?</h2><p>Tumhari jagah bot khelega. Wapas aao toh seat mil sakti hai.</p><button class="cta" data-act="leave" type="button">Haan, chhodo</button><button class="cta ghost" data-act="close" type="button">Nahi, khelte raho</button>`,{leave:()=>{closeSheet();NET.follow=false;netSend({t:'leave'});}})};
  NET.stateAt=Date.now();
  const firstTime=NET.chromeKey!==st.code;
  G.cfg=cfg;G.names=names;G.icons=icons;G.logs=NET.logs;
  if(firstTime){NET.chromeKey=st.code;setupChrome();}
  else $('youIc').innerHTML=av(icons[0]);
  const g=st.game;
  if(g){
    G.hands=[g.hand,...[1,2,3].map(r=>Array(g.counts[nAbs(r)]).fill(0))];
    G.trick=g.trick.map(t=>({p:nRel(t.p),c:t.c}));
    G.pileTricks=Array(g.pileN).fill(0);
    G.trump=g.trump;G.trumpSetter=g.trumpSetter===null?null:nRel(g.trumpSetter);
    G.streak={p:g.streak===null?null:nRel(g.streak)};
    G.tens=[g.tens[mt],g.tens[1-mt]];
    G.turn=nRel(g.turn);G.phase='play';G.resolving=g.resolving;G.timeLeft=g.timeLeft;G.pending=false;
    render();armTimer();
    if(g.resolving){const s0=st;setTimeout(()=>{if(NET.state===s0)$('center').classList.add('sweep');},1100);}
  } else {
    G.phase='end';G.trick=[];G.resolving=false;clearTimer();
    if(!G.hands)G.hands=[[],[],[],[]];
    if(!G.tens)G.tens=[[],[]];
    if(!G.streak)G.streak={p:null};
    render();
    const key=`${st.code}-${T.played}-${st.phase}`;
    if(NET.resultKey!==key){NET.resultKey=key;showOnlineResult(st);}
    else{const el=document.getElementById('rdyN');if(el)el.textContent=readyText(st);}
  }
}
function readyText(st){const hum=st.seats.filter(s=>s&&!s.bot&&s.connected).length;return `${st.ready.length}/${hum} ready · warna 25 sec mein khud shuru`;}
function showOnlineResult(st){
  const me=st.me,mt=me%2,T=st.table,K=T.kot,r=st.result;
  const holder=K.holder===null?null:(K.holder===mt?0:1),kt=r.kotTo===null?null:(r.kotTo===mt?0:1);
  const n0=esc(nTeam(mt)),n1=esc(nTeam(1-mt));
  const us=mt===0?r.a:r.b,them=mt===0?r.b:r.a;
  if(kt===1)bump('kotGiven');if(kt===0)bump('kotTaken');
  let head,tone,line;
  if(kt===1){head='Kot!';tone='good';line=`${n0} ne chaaron dehle pakde. ${n1} ko Kot! Sharam karo.`;}
  else if(kt===0){head='Kot';tone='bad';line=`${n1} ne chaaron dehle pakde. ${n0} ko Kot.`;}
  else{head=us>them?'3–1 tumhara':us<them?'3–1 unka':'2–2';tone='';line='Table pe dehle se kuch nahi badalta. Sirf Kot count hota hai.';}
  const kotRow=`<div class="prow r1"><div class="pl"><span class="pr">1</span><div><b>Kot</b><small>Table pe abhi</small></div></div><div class="pv ${holder===1?'lead':''}"><span>${n0}</span><b>${kotBadge(holder===0?K.n:0,'md',holder===1?K.n:0)}</b></div><div class="pv ${holder===0?'lead':''}"><span>${n1}</span><b>${kotBadge(holder===1?K.n:0,'md',holder===0?K.n:0)}</b></div></div>`;
  const hist=`<p class="lab" style="margin:14px 0 6px">Game by game</p><div class="hist">${T.history.map((h,i)=>{const k=h.kotTo===null?null:(h.kotTo===mt?0:1);const a=mt===0?h.a:h.b,b=mt===0?h.b:h.a;return `<span class="hg ${k===null?'':(k===0?'kb':'kg')}"><small>G${i+1}</small>${k===null?`${a}–${b}`:`KOT → ${k===0?n0:n1}`}</span>`;}).join('')}</div>`;
  if(st.phase==='result'){
    openSheet(`<div class="result ${tone}">${head}</div><p>${line}</p><div class="prio">${kotRow}
      <div class="prow r3"><div class="pl"><span class="pr">2</span><div><b>Is game</b><small>Dehle · haath</small></div></div><div class="pv"><span>${n0}</span><b>${us} · ${r.haath[mt]}</b></div><div class="pv"><span>${n1}</span><b>${them} · ${r.haath[1-mt]}</b></div></div></div>
      ${hist}<button class="cta" data-act="ready" type="button" style="margin-top:16px">Agla game</button><p class="testnote" id="rdyN">${readyText(st)}</p>`,
      {ready:b=>{netSend({t:'ready'});b.disabled=true;b.textContent='Baaki players ka intezaar…';}},true);
  } else {
    const draw=holder===null,won=holder===1,isHost=st.host===me;
    bump('tablesP');if(won)bump('tablesW');
    openSheet(`<div class="result ${draw?'':won?'good':'bad'}">${draw?'Draw':won?'Table Win!':'Table Lose'}</div>
      <p>${draw?'Table khatam aur Kot kisi ke paas nahi. Isliye draw.':won?`${n1} ${K.n} Kot ke saath table se gaye. ${n0} Baadshah!`:`${n0} ${K.n} Kot ke saath table se gaye. ${n1} Baadshah.`}</p>
      <div class="prio">${kotRow}</div>${hist}
      ${isHost?'<button class="cta" data-act="again" type="button" style="margin-top:16px">Rematch, same players</button>':'<p class="testnote">Host rematch shuru kar sakta hai.</p>'}
      <button class="cta ghost" data-act="home" type="button">Table chhodo</button>`,
      {again:()=>{closeSheet();netSend({t:'host',a:'rematch'});},home:()=>{closeSheet();NET.follow=false;netSend({t:'leave'});}},true);
  }
}

function renderOLobby(){
  const st=NET.state,me=st.me,isHost=st.host===me,S=st.settings,full=st.seats.every(Boolean);
  $('olSub').textContent=`Host: ${st.host===me?'Tum':st.seats[st.host]?st.seats[st.host].name:'?'} · ${st.seats.filter(Boolean).length}/4 players`;
  const chip=i=>{const s=st.seats[i];
    if(!s) return isHost?`<button type="button" class="pchip empty ${NET.sel!==null?'sel':''}" data-seat="${i}">${NET.sel!==null?'Yahan rakho':'+ Bot bithao'}</button>`:`<div class="pchip empty">Khali seat</div>`;
    const sub=i===st.host?'Host':s.bot?'Bot':s.connected?'Friend':'Offline';
    return `<button type="button" class="pchip ${NET.sel===i?'sel':''}" data-seat="${i}" ${isHost?'':'disabled'}><span class="ic">${av(nIcon(i))}</span><div><b>${esc(s.name)}${i===me?' (Tum)':''}</b><small>${sub}</small></div>${isHost&&s.bot?`<span class="rmb" data-rm="${i}" aria-label="Bot hatao">✕</span>`:''}</button>`;};
  const col=t=>`<div class="tcol ${t===me%2?'us':'them'}"><button class="tedit" type="button" data-tn="${t}" ${isHost||me%2===t?'':'disabled'}>${crest(nTeam(t),t===me%2?1:2,'sm')}<h3>${esc(nTeam(t))}</h3>${isHost||me%2===t?'<span>Naam ✎</span>':''}</button>${chip(t)}${chip(t+2)}</div>`;
  const url=`${location.origin}/?join=${st.code}`;
  let html=`<div class="codebox"><div><p class="lab" style="margin:0 0 2px">Table code</p><b>DP-${st.code}</b></div><button class="pill" type="button" id="olShare">Invite bhejo</button></div>`;
  html+=`<div class="panel"><div class="row" style="margin-bottom:10px"><p class="lab" style="margin:0">Teams</p>${isHost?'<button class="pill" type="button" id="olRand">Randomise</button>':''}</div>
    <div class="teamsetup">${col(me%2)}${col(1-me%2)}</div>
    <p class="muted" style="font-size:12px;margin:4px 0 0">${isHost?'Do players pe tap karo unki jagah badalne ke liye. Khali seat pe bot bitha sakte ho.':'Host teams aur settings set karega.'}</p></div>`;
  if(isHost){
    html+=`<div class="panel stack-v"><div><p class="lab">Table kitni der</p><div class="seg">${['games','time'].map(k=>`<button class="pill ${S.lengthType===k?'on':''}" data-lt="${k}" type="button">${k==='games'?'Games':'Time'}</button>`).join('')}</div></div>
      <div class="seg">${S.lengthType==='games'?[5,7,11].map(n=>`<button class="pill ${S.games===n?'on':''}" data-gn="${n}" type="button">${n} games</button>`).join(''):[[5,'5 min'],[30,'30 min'],[60,'1 ghanta']].map(([n,l])=>`<button class="pill ${S.minutes===n?'on':''}" data-mn="${n}" type="button">${l}</button>`).join('')}</div>
      <div class="row"><div><b>Dehle points dikhao</b><small>Sirf dikhenge, result Kot se hi hoga</small></div><button class="tog ${S.showDehle?'on':''}" id="olDehle" type="button" aria-label="Dehle points"></button></div></div>`;
    html+=`<button class="cta" type="button" id="olStart" ${full?'':'disabled'}>${full?'Table shuru karo':'Chaar players chahiye…'}</button>`;
  } else {
    html+=`<div class="panel"><p class="lab">Host ki settings</p><p style="margin:0;line-height:1.5">${S.lengthType==='games'?S.games+' games':S.minutes+' min'} · Sirf Kot count${S.showDehle?' · Dehle points dikhenge':''} · 60s timer</p></div>
      <button class="cta" type="button" disabled>Host ke start karne ka intezaar…</button>`;
  }
  $('olBody').innerHTML=html;
  const q=id=>$(id);
  q('olShare').addEventListener('click',async()=>{const text=`Dehla Pakad khelne aao! Table code DP-${st.code}`;
    try{if(navigator.share){await navigator.share({title:'Dehla Pakad',text,url});return;}}catch(e){if(e&&e.name==='AbortError')return;}
    try{await navigator.clipboard.writeText(`${text}\n${url}`);toast('Invite copy ho gaya. WhatsApp pe paste karo.');}catch(e){toast(`Code: DP-${st.code}`);}});
  if(q('olRand'))q('olRand').addEventListener('click',()=>netSend({t:'host',a:'randomize'}));
  if(q('olStart'))q('olStart').addEventListener('click',()=>netSend({t:'host',a:'start'}));
  if(q('olDehle'))q('olDehle').addEventListener('click',()=>netSend({t:'host',a:'settings',settings:{showDehle:!S.showDehle}}));
  $('olBody').querySelectorAll('[data-lt]').forEach(b=>b.addEventListener('click',()=>netSend({t:'host',a:'settings',settings:{lengthType:b.dataset.lt}})));
  $('olBody').querySelectorAll('[data-gn]').forEach(b=>b.addEventListener('click',()=>netSend({t:'host',a:'settings',settings:{games:+b.dataset.gn}})));
  $('olBody').querySelectorAll('[data-mn]').forEach(b=>b.addEventListener('click',()=>netSend({t:'host',a:'settings',settings:{minutes:+b.dataset.mn}})));
  $('olBody').querySelectorAll('[data-tn]').forEach(b=>b.addEventListener('click',()=>{const t=+b.dataset.tn;nameSheet('Team ka naam',st.teamNames[t],[st.teamNames[1-t]],v=>netSend({t:'host',a:'teamName',team:t,name:v}));}));
  $('olBody').querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();netSend({t:'host',a:'removeBot',seat:+b.dataset.rm});}));
  $('olBody').querySelectorAll('[data-seat]').forEach(b=>b.addEventListener('click',()=>{
    if(!isHost)return;const i=+b.dataset.seat;
    if(NET.sel===null){ if(!st.seats[i]){netSend({t:'host',a:'addBot'});return;} NET.sel=i;renderOLobby();return; }
    if(NET.sel===i){NET.sel=null;renderOLobby();return;}
    netSend({t:'host',a:'swap',x:NET.sel,y:i});NET.sel=null;
  }));
}
$('olBack').addEventListener('click',()=>openSheet(`<h2>Table chhodni hai?</h2><p>Tumhari seat khali ho jayegi.</p><button class="cta" data-act="leave" type="button">Haan, chhodo</button><button class="cta ghost" data-act="close" type="button">Nahi</button>`,{leave:()=>{closeSheet();NET.follow=false;netSend({t:'leave'});}}));
