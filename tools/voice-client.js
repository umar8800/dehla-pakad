/* ================= voice chat (LiveKit) ================= */
const VOICE={room:null,channel:'table',connecting:false,joinedFor:null,muted:new Set(),holding:false,lib:null};
function loadLK(){
  if(window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if(!VOICE.lib) VOICE.lib=new Promise((res,rej)=>{const sc=document.createElement('script');sc.src='/vendor/livekit-client.js';sc.onload=()=>res(window.LivekitClient);sc.onerror=()=>{VOICE.lib=null;rej(new Error('load'));};document.head.appendChild(sc);});
  return VOICE.lib;
}
function voiceWanted(){const st=NET.state;return !!(st&&st.voice&&NET.follow&&(!$('scr-olobby').hidden||!$('scr-game').hidden));}
function voiceSync(){
  const st=NET.state;
  if(!voiceWanted()){ if(VOICE.room||VOICE.joinedFor) voiceLeave(); return; }
  const key=`${st.code}-${VOICE.channel}-${st.me<0?'w':st.me}`;
  if(VOICE.joinedFor===key||VOICE.connecting) return;
  if(VOICE.room) voiceLeave();
  VOICE.connecting=true; VOICE.joinedFor=key;
  netSend({t:'voiceToken',channel:VOICE.channel});
}
async function voiceOnToken(m){
  try{
    const LK=await loadLK();
    const room=new LK.Room({adaptiveStream:true,dynacast:true,audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    room.on(LK.RoomEvent.TrackSubscribed,(track,pub,who)=>{if(track.kind==='audio'){const el=track.attach();el.dataset.who=who.identity;$('voiceAudio').appendChild(el);applyVolumes();}});
    room.on(LK.RoomEvent.TrackUnsubscribed,track=>{track.detach().forEach(el=>el.remove());});
    room.on(LK.RoomEvent.ActiveSpeakersChanged,sp=>voiceLights(sp));
    room.on(LK.RoomEvent.ParticipantConnected,()=>applyVolumes());
    room.on(LK.RoomEvent.AudioPlaybackStatusChanged,()=>voiceBars());
    room.on(LK.RoomEvent.Disconnected,()=>{if(VOICE.room===room){VOICE.room=null;VOICE.joinedFor=null;voiceBars();setTimeout(voiceSync,3000);}});
    await room.connect(m.url,m.token);
    if(!voiceWanted()){room.disconnect();return;}
    VOICE.room=room; VOICE.channel=m.channel;
    await applyMic(false); applyVolumes(); voiceBars();
  }catch(e){ VOICE.joinedFor=null; toast('Voice chat jud nahi paya. Thodi der mein phir try karenge.','them'); setTimeout(voiceSync,8000); }
  finally{ VOICE.connecting=false; }
}
function voiceLeave(){const r=VOICE.room;VOICE.room=null;VOICE.joinedFor=null;if(r)r.disconnect();$('voiceAudio').innerHTML='';voiceLights([]);}
async function applyMic(hold){
  const r=VOICE.room,st=NET.state;
  if(!r||!st||st.me<0) return;
  const on=APP.voice.mic==='Open'||(APP.voice.mic==='PTT'&&!!hold);
  try{ await r.localParticipant.setMicrophoneEnabled(on); }
  catch(e){ APP.voice.mic='Off'; voiceBars(); toast('Mic ki permission chahiye. Browser settings mein mic allow karo.','them'); }
}
function applyVolumes(){const r=VOICE.room;if(!r)return;r.remoteParticipants.forEach(p=>p.setVolume(APP.voice.speaker&&!VOICE.muted.has(p.identity)?1:0));}
function unlockAudio(){if(VOICE.room)VOICE.room.startAudio().catch(()=>{});}
function voiceLights(speakers){
  const ids=new Set(speakers.map(p=>p.identity)),st=NET.state;
  for(const r of [1,2,3]){const el=$('seat'+r);if(el)el.classList.toggle('talk',!!st&&ids.has('seat-'+nAbs(r)));}
  $('youLab').classList.toggle('talk',!!st&&st.me>=0&&ids.has('seat-'+st.me));
  document.querySelectorAll('#olBody .pchip[data-seat]').forEach(c=>c.classList.toggle('talk',ids.has('seat-'+c.dataset.seat)));
}
function voiceBars(){ if(VOICE.holding) return; document.querySelectorAll('[data-vhost]').forEach(mountVoiceReal); }
function mountVoiceReal(host){
  const st=NET.state,V=APP.voice;
  if(!st||!st.voice){host.innerHTML='';return;}
  const watching=st.me<0,r=VOICE.room;
  const status=r?(r.canPlaybackAudio?'':'<button class="pill on" data-v="unlock" type="button">🔈 Awaaz chalu karo</button>'):'<span class="note">Voice jud raha hai…</span>';
  host.innerHTML=`<div class="voice">${watching?'<span class="note" style="margin:0">👀 Sirf sun sakte ho</span>':`<button class="pill" data-v="mode" type="button">${V.mic==='Open'?'🎙 Open mic':V.mic==='PTT'?'🎙 Push-to-talk':'🔇 Mic off'}</button>
    ${V.mic==='PTT'?'<button class="pill ptt" data-v="talk" type="button">Dabake bolo</button>':''}`}
    <button class="pill" data-v="spk" type="button" aria-label="Speaker">${V.speaker?'🔈':'🔇'}</button>
    ${watching?'':`<button class="pill" data-v="ch" type="button">${VOICE.channel==='team'?'Sirf team':'Sab'}</button>`}${status}</div>`;
  const q=k=>host.querySelector(`[data-v="${k}"]`);
  if(q('unlock'))q('unlock').addEventListener('click',()=>{unlockAudio();setTimeout(voiceBars,300);});
  if(q('mode'))q('mode').addEventListener('click',()=>{unlockAudio();V.mic=V.mic==='PTT'?'Open':V.mic==='Open'?'Off':'PTT';applyMic(false);voiceBars();
    toast(V.mic==='PTT'?'Push-to-talk: button dabake bolo':V.mic==='Open'?'Open mic: sab sun rahe hain':'Mic band');});
  const t=q('talk');
  if(t){const down=e=>{e.preventDefault();unlockAudio();VOICE.holding=true;t.classList.add('hold');$('youLab').classList.add('talk');applyMic(true);},
    up=()=>{if(!VOICE.holding)return;VOICE.holding=false;t.classList.remove('hold');$('youLab').classList.remove('talk');applyMic(false);};
    t.addEventListener('pointerdown',down);t.addEventListener('pointerup',up);t.addEventListener('pointerleave',up);t.addEventListener('pointercancel',up);
    t.addEventListener('contextmenu',e=>e.preventDefault());}
  q('spk').addEventListener('click',()=>{unlockAudio();V.speaker=!V.speaker;applyVolumes();voiceBars();toast(V.speaker?'Speaker on':'Speaker off');});
  if(q('ch'))q('ch').addEventListener('click',()=>{unlockAudio();VOICE.channel=VOICE.channel==='team'?'table':'team';voiceLeave();voiceSync();voiceBars();
    toast(VOICE.channel==='table'?'Ab sab sun sakte hain':'Ab sirf tumhara partner sunega');});
}
function voiceMuteToggle(absSeat){
  const id='seat-'+absSeat;
  if(VOICE.muted.has(id))VOICE.muted.delete(id);else VOICE.muted.add(id);
  applyVolumes();toast(`${esc(nName(absSeat))} ${VOICE.muted.has(id)?'mute':'unmute'} ho gaya`);
}
