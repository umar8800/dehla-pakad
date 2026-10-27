/* ================= ranking (from the server) ================= */
const RANK={data:null};
function openRanking(tab){stopSim();clearTimer();G.token++;APP.rankTab=tab||APP.rankTab||'global';renderRanking();show('scr-rank');netSend({t:'rank'});}
function onRank(m){
  RANK.data=m;
  if(m.me){Object.assign(APP.stats,{tw:m.me.tw,finals:m.me.finals,tours:m.me.tours,tablesW:m.me.tablesW,tablesP:m.me.tablesP,kotGiven:m.me.kg,kotTaken:m.me.kt});try{localStorage.setItem('dp-stats',JSON.stringify(APP.stats));}catch(e){}}
  if(!$('scr-rank').hidden) renderRanking();
}
function renderRanking(){
  const D=RANK.data,tab=APP.rankTab;
  if(!D||!D.enabled){$('rkBody').innerHTML=`<div class="panel"><p class="muted" style="margin:0">${!D?(NET.connected?'Ranking aa rahi hai…':'Ranking ke liye internet chahiye.'):'Ranking abhi band hai. Database jud nahi raha.'}</p></div>`;return;}
  const me=D.me,medal=i=>i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1;
  const list=tab==='friends'?D.friends:tab==='shame'?D.shame:D.global;
  const row=(p,i)=>`<div class="rk ${p.me?'me':''}"><span class="pos ${i<3?'m':''}">${medal(i)}</span><span class="ic">${av(p.icon)}</span>
    <div class="nm"><b>${esc(p.name)}${p.me?' (Tum)':''}</b><small>${tab==='shame'?`${p.tw} tournament wins · ${p.games} games`:`${p.finals} finals · Kot diye ${p.kg} · ${p.games} games`}</small></div>
    <div class="val">${tab==='shame'?kotBadge(p.kt,'sm'):`🏆 ${p.tw}`}</div></div>`;
  let rows=list.map(row).join('');
  if(tab==='global'&&me&&!list.some(p=>p.me)) rows+=`<div class="rkgap">• • •</div>`+row({...me},me.rank-1);
  if(!list.length) rows=`<p class="empty">${tab==='shame'?'Abhi tak kisi ko Kot nahi mila. 👑':'Abhi koi game nahi khela gaya.'}</p>`;
  const tabs=[['global','Global'],['friends','Friends'],['shame','Hall of Shame']];
  const s=me||{tw:0,finals:0,kg:0,kt:0,rank:'–'};
  $('rkBody').innerHTML=`
  <div class="panel mycard">
    <div class="row"><div class="meid"><span class="ic">${av(APP.profile.icon)}</span><div><b>${esc(APP.profile.name)}</b><small>${me?`Global rank #${me.rank} / ${D.total}`:'Pehla game khelo, ranking mein aa jaoge'}</small></div></div>
      <div class="bigtw"><b>🏆 ${s.tw}</b><small>Tournament wins</small></div></div>
    <div class="statgrid"><div><b>${s.finals}</b><span>Finals</span></div><div><b>${s.kg}</b><span>Kot diye</span></div><div class="bad"><b>${s.kt}</b><span>Kot khaye</span></div></div>
  </div>
  <div class="tabs" style="margin:0">${tabs.map(([k,l])=>`<button class="pill ${tab===k?'on':''}" data-rt="${k}" type="button">${l}</button>`).join('')}</div>
  <div class="rklist">${rows}</div>
  <p class="muted" style="font-size:12px;margin:0">${tab==='shame'?'Sabse zyada Kot khane wale. Yahan upar aana sharam ki baat hai.':tab==='friends'?'Jinke saath tumne table pe khela hai.':'Team tournament Win kare toh dono players ko 1 win milti hai. Order: tournament wins, phir finals, phir Kot diye, phir kam Kot khaye.'}</p>`;
  $('rkBody').querySelectorAll('[data-rt]').forEach(b=>b.addEventListener('click',()=>{APP.rankTab=b.dataset.rt;renderRanking();}));
}

/* ================= tournaments (online) ================= */
const TOUR={state:null,follow:false,arrange:false,sel:null,tab:'live',champShown:null,setup:{gpm:2,perTeam:6,prize:'₹500 Amazon voucher'}};
function stopSim(){clearJoins();}
const tourEst=(gpm,per)=>{const min=(per+2)*gpm*7;return min<90?`~${Math.round(min/5)*5} min`:`~${(min/60).toFixed(1).replace('.0','')} ghante`;};
function openTourSetup(){renderTourSetup();show('scr-tsetup');}
function renderTourSetup(){
  const S=TOUR.setup;
  const seg=(key,opts)=>`<div class="seg">${opts.map(([v,l])=>`<button class="pill ${S[key]===v?'on':''}" data-k="${key}" data-v="${v}" type="button">${l}</button>`).join('')}</div>`;
  $('tsBody').innerHTML=`
  <div class="panel stack-v"><div><p class="lab">Har match mein games</p>${seg('gpm',[[1,'1'],[2,'2'],[3,'3'],[6,'6'],[8,'8']])}</div>
    <div><p class="lab">League mein har team ke matches</p>${seg('perTeam',[[6,'6'],[7,'7'],[8,'8']])}</div>
    <p class="muted" style="font-size:12px;margin:0">Kam teams hon toh sab sabse khelenge (repeat bhi). 3 teams mein har jodi 2 baar. Andaaza: <b style="color:var(--ink)">${tourEst(S.gpm,S.perTeam)}</b>, agar matches saath-saath chalein.</p></div>
  <div class="panel stack-v"><div><p class="lab">Prize (optional)</p>
      <input class="input" id="tsPrize" maxlength="40" value="${esc(S.prize)}" placeholder="Jaise: ₹500 Amazon voucher" autocomplete="off"></div>
    <div class="seg">${['₹500 Amazon voucher','₹1000 Amazon voucher','Koi prize nahi'].map(x=>`<button class="pill ${S.prize===x||(x==='Koi prize nahi'&&!S.prize)?'on':''}" data-prize="${x}" type="button">${x}</button>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:0">Entry free hai. Jeetne wali team apna email bhejegi; tumhe app mein dikhega aur voucher tum khud bhejoge.</p></div>
  <div class="panel"><p class="lab">Points</p><p style="margin:0;line-height:1.5">1 point har dehla · Kot pe 6 points · Haath sirf semi-final aur final mein tie todte hain. 4+ teams: top 4 semi-final mein. 3 teams: top 2 seedha final.</p></div>
  <button class="cta" id="tsGo" type="button">Lobby kholo</button>`;
  $('tsBody').querySelectorAll('[data-k]').forEach(b=>b.addEventListener('click',()=>{S[b.dataset.k]=+b.dataset.v;renderTourSetup();}));
  $('tsPrize').addEventListener('input',e=>{S.prize=e.target.value.trim();});
  $('tsBody').querySelectorAll('[data-prize]').forEach(b=>b.addEventListener('click',()=>{S.prize=b.dataset.prize==='Koi prize nahi'?'':b.dataset.prize;renderTourSetup();}));
  $('tsGo').addEventListener('click',()=>{TOUR.follow=true;netSend({t:'tourCreate',settings:S});toast('Tournament ban raha hai…');});
}

function tourPlayer(id){return TOUR.state.players.find(p=>p.id===id);}
function renderTLobby(){
  const T=TOUR.state,me=T.players.find(p=>p.you),host=T.isHost,humans=T.players.filter(p=>!p.bot);
  const solo=humans.filter(p=>p.team===null),url=`${location.origin}/?join=${T.code}`;
  $('lbSub').textContent=`Host: ${host?'Tum':T.hostName} · ${humans.length} players`;
  const chip=p=>{const s=[];if(p.you)s.push('Tum');if(p.bot)s.push('Bot');else if(!p.connected)s.push('Offline');
    if(me&&p.want===me.id&&!p.you)s.push('<b style="color:var(--brass)">Tumhe chuna!</b>');if(me&&me.want===p.id)s.push('Request bheji');
    return `<button type="button" class="pchip ${TOUR.sel===p.id?'sel':''}" data-tp="${p.id}"><span class="ic">${av(p.icon)}</span><div><b>${esc(p.name)}</b><small>${s.join(' · ')||'&nbsp;'}</small></div>${host&&!TOUR.arrange&&p.team===null&&!p.bot?`<span class="rmb" data-botp="${p.id}" aria-label="Bot partner">🤖</span>`:''}</button>`;};
  const canName=t=>host||(me&&t.ids.includes(me.id));
  let html=`${T.settings.prize?`<div class="codebox"><div><p class="lab" style="margin:0 0 2px">Prize</p><b style="font-size:17px;letter-spacing:0">🎁 ${esc(T.settings.prize)}</b></div><span class="muted" style="font-size:11px;text-align:right">Free entry<br>Winning team ko</span></div>`:''}
  <div class="codebox"><div><p class="lab" style="margin:0 0 2px">Tournament code</p><b>DP-${T.code}</b></div><button class="pill" type="button" id="tlShare">Invite bhejo</button></div>
  <div class="counter"><div><b>${humans.length}</b><span>Players</span></div><div><b>${T.teams.length}</b><span>Teams</span></div><div><b>${solo.length}</b><span>Partner dhoond rahe</span></div></div>
  <div class="panel"><div class="row" style="margin-bottom:10px"><p class="lab" style="margin:0">Teams</p>${host?`<div class="seg"><button class="pill ${TOUR.arrange?'on':''}" id="tlArr" type="button">${TOUR.arrange?'Arrange: on':'Arrange'}</button><button class="pill" id="tlRand" type="button">Randomise</button></div>`:''}</div>
    ${T.teams.length?`<div class="lteams">${T.teams.map(t=>`<div class="lteam ${me&&t.ids.includes(me.id)?'mine':''}"><button class="tedit" type="button" data-tn="${t.idx}" ${canName(t)?'':'disabled'}>${crest(t.name,t.idx,'sm')}<h3>${esc(t.name)}</h3>${canName(t)?'<span>✎</span>':''}</button>${t.ids.map(id=>chip(tourPlayer(id))).join('')}</div>`).join('')}</div>`:'<p class="muted" style="margin:0 0 8px;font-size:13px">Abhi koi team nahi bani.</p>'}
    ${solo.length?`<p class="lab" style="margin:12px 0 8px">Partner dhoond rahe</p><div class="lteams">${solo.map(chip).join('')}</div>`:''}
    <p class="muted" style="font-size:12px;margin:8px 0 0">${TOUR.arrange?'Do players pe tap karo, unki team badal jayegi.':me&&me.team===null?'Jise partner banana hai us pe tap karo. Jab woh bhi tumhe chunega, team ban jayegi.':'Team ban gayi. Host Randomise ya Arrange se teams badal sakta hai.'}</p>
    ${me&&me.team!==null?'<button class="cta ghost" type="button" id="tlBreak" style="margin-top:10px">Team todo</button>':''}</div>
  <div class="panel"><div class="row"><div><b>Settings</b><small>${T.settings.gpm} game${T.settings.gpm>1?'s':''} har match · ${T.settings.perTeam} league matches har team · ${tourEst(T.settings.gpm,T.settings.perTeam)}</small></div>${host?'<button class="pill" id="tlSet" type="button">Badlo</button>':''}</div></div>
  ${host?`<button class="cta" id="tlStart" type="button" ${T.teams.length>=3&&!solo.length?'':'disabled'}>${T.teams.length<3?'Kam se kam 3 teams chahiye':solo.length?'Sabki team banni chahiye':'Tournament shuru karo'}</button>`:'<button class="cta" type="button" disabled>Host ke start karne ka intezaar…</button>'}
  <button class="cta ghost" id="tlLeave" type="button">Tournament chhodo</button>`;
  $('lbBody').innerHTML=html;
  const q=$;
  q('tlShare').addEventListener('click',async()=>{const text=`Dehla Pakad tournament! Code DP-${T.code}${T.settings.prize?' · Prize: '+T.settings.prize:''}`;
    try{if(navigator.share){await navigator.share({title:'Dehla Pakad',text,url});return;}}catch(e){if(e&&e.name==='AbortError')return;}
    try{await navigator.clipboard.writeText(`${text}\n${url}`);toast('Invite copy ho gaya. WhatsApp pe paste karo.');}catch(e){toast(`Code: DP-${T.code}`);}});
  if(q('tlArr'))q('tlArr').addEventListener('click',()=>{TOUR.arrange=!TOUR.arrange;TOUR.sel=null;renderTLobby();});
  if(q('tlRand'))q('tlRand').addEventListener('click',()=>netSend({t:'tour',a:'randomize'}));
  if(q('tlBreak'))q('tlBreak').addEventListener('click',()=>netSend({t:'tour',a:'leaveTeam'}));
  if(q('tlStart'))q('tlStart').addEventListener('click',()=>netSend({t:'tour',a:'start'}));
  if(q('tlSet'))q('tlSet').addEventListener('click',()=>tourSettingsSheet());
  q('tlLeave').addEventListener('click',()=>openSheet(`<h2>Tournament chhodna hai?</h2><p>Tum lobby se nikal jaoge.</p><button class="cta" data-act="leave" type="button">Haan, chhodo</button><button class="cta ghost" data-act="close" type="button">Nahi</button>`,{leave:()=>{closeSheet();netSend({t:'tourLeave'});}}));
  $('lbBody').querySelectorAll('[data-tn]').forEach(b=>b.addEventListener('click',()=>{const t=T.teams[+b.dataset.tn];nameSheet('Team ka naam',t.name,T.teams.filter(x=>x!==t).map(x=>x.name),v=>{if(v)netSend({t:'tour',a:'teamName',team:t.idx,name:v});});}));
  $('lbBody').querySelectorAll('[data-botp]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();netSend({t:'tour',a:'botPartner',id:+b.dataset.botp});}));
  $('lbBody').querySelectorAll('[data-tp]').forEach(b=>b.addEventListener('click',()=>{
    const id=+b.dataset.tp,p=tourPlayer(id);
    if(TOUR.arrange){ if(TOUR.sel===null||TOUR.sel===id){TOUR.sel=TOUR.sel===id?null:id;renderTLobby();return;} netSend({t:'tour',a:'swap',x:TOUR.sel,y:id});TOUR.sel=null;return; }
    if(!me||p.you||p.bot)return;
    if(me.team!==null){toast('Tum pehle se team mein ho. Badalna hai toh "Team todo".');return;}
    if(p.team!==null){toast(`${esc(p.name)} pehle se team mein hai`);return;}
    netSend({t:'tour',a:'pick',id});
  }));
}
function tourSettingsSheet(){
  const S={...TOUR.state.settings};
  const draw=()=>{const seg=(key,opts)=>`<div class="seg">${opts.map(([v,l])=>`<button class="pill ${S[key]===v?'on':''}" data-act="set" data-k="${key}" data-v="${v}" type="button">${l}</button>`).join('')}</div>`;
    openSheet(`<div class="sheethead"><h2>Tournament settings</h2><button class="pill" data-act="close" type="button">Close</button></div>
      <p class="lab">Har match mein games</p>${seg('gpm',[[1,'1'],[2,'2'],[3,'3'],[6,'6'],[8,'8']])}
      <p class="lab" style="margin-top:12px">League mein har team ke matches</p>${seg('perTeam',[[6,'6'],[7,'7'],[8,'8']])}
      <p class="lab" style="margin-top:12px">Prize</p><input class="input" id="tsP2" maxlength="40" value="${esc(S.prize)}">
      <p class="muted" style="font-size:12px">Andaaza: ${tourEst(S.gpm,S.perTeam)}</p>
      <button class="cta" data-act="save" type="button">Save karo</button>`,
    {set:b=>{S.prize=$('tsP2').value.trim();S[b.dataset.k]=+b.dataset.v;draw();},save:()=>{S.prize=$('tsP2').value.trim();netSend({t:'tour',a:'settings',settings:S});closeSheet();}});};
  draw();
}

function tourModel(){
  const T=TOUR.state;
  return {teams:T.teams.map(t=>({idx:t.idx,name:t.name,players:t.ids.map(id=>tourPlayer(id)).filter(Boolean)})),
    matches:T.matches,myTeam:T.myTeam,phase:T.phase,champion:T.champion,prize:T.settings.prize,tab:TOUR.tab};
}
const busy=(R,t)=>R.matches.some(m=>(m.status==='live'||m.status==='ready')&&(m.a===t||m.b===t));
const isMine=m=>APP.tour&&APP.tour.myTeam>=0&&(m.a===APP.tour.myTeam||m.b===APP.tour.myTeam);
function stageMatches(){const R=APP.tour;return R.matches.filter(m=>R.phase==='league'?m.stage==='league':m.stage===R.phase);}
function playMyMatch(id){const m=TOUR.state.matches.find(x=>x.id===id);if(!m||!m.roomCode)return;NET.follow=true;netSend({t:'join',code:m.roomCode});}

function renderTour(){
  const T=TOUR.state;if(!T)return;
  const inTable=!$('scr-game').hidden||!$('scr-olobby').hidden;
  if(T.phase==='lobby'){ renderTLobby(); if(TOUR.follow&&!inTable&&$('scr-lobby').hidden){closeSheet();show('scr-lobby');} }
  else{
    APP.tour=tourModel();
    if(TOUR.follow&&!inTable&&$('scr-dash').hidden){closeSheet();show('scr-dash');}
    if(!$('scr-dash').hidden) renderDash();
    if(T.phase==='done'&&TOUR.champShown!==T.code&&!$('scr-dash').hidden){TOUR.champShown=T.code;champSheet();}
  }
  voiceSync();voiceBars();
}
function champSheet(){
  const T=TOUR.state,C=APP.tour.teams[T.champion],mine=T.myTeam===T.champion;
  openSheet(`<div class="champ"><div class="big">🏆</div><h2>${esc(C.name)}</h2><p>${C.players.map(p=>p.you?'Tum':esc(p.name)).join(' + ')} ne tournament Win kiya!</p>${mine?'<p style="color:var(--brass);font-weight:700">Tumhe aur tumhare partner, dono ko ranking mein +1 tournament win.</p>':''}</div>
    ${T.settings.prize&&mine&&!T.claimed?`<div class="panel stack-v" style="margin-bottom:12px"><div><p class="lab">🎁 Tumne Win kiya: ${esc(T.settings.prize)}</p><p class="muted" style="margin:0 0 8px;font-size:12.5px">Apna email bhejo. Host voucher khud email karega.</p>
      <input class="input" id="claimEmail" type="email" placeholder="tumhara@email.com" autocomplete="email"></div><button class="cta" data-act="claim" type="button">Email bhejo</button></div>`:''}
    ${T.settings.prize&&!mine?`<p class="muted" style="text-align:center">🎁 ${esc(T.settings.prize)} ${esc(C.name)} ko milega.</p>`:''}
    <button class="cta${T.settings.prize&&mine&&!T.claimed?' ghost':''}" data-act="close" type="button">Dashboard dekho</button>`,
  {claim:()=>{const v=$('claimEmail').value.trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)){toast('Sahi email likho, jaise naam@gmail.com','them');return;}netSend({t:'tour',a:'claim',email:v});closeSheet();toast('Email host ko bhej diya. Voucher jaldi aayega 🎁');}});
}
