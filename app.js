// 📡 تردد القطاعات — موقع تجربة الروم الصوتي (نسخة من نظام المقابلة في app_29.js)
// تشغيل:  npm i express  ثم  node app_30.js   (المتصفح لازم HTTPS أو localhost عشان المايك)
const express = require("express"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));
const PORT = process.env.PORT || 7800;
const REC_DIR = path.join(__dirname, "recordings"); fs.mkdirSync(REC_DIR, { recursive: true });

const room = { mode: "open", chat: [], people: new Map(), rec: null };
const conns = new Map(), pending = new Map();

function send(uid, p) {
    const r = conns.get(uid);
    if (r) r.write("data: " + JSON.stringify(p) + "\n\n");
    else { if (!pending.has(uid)) pending.set(uid, []); pending.get(uid).push(p); }
}
const state = () => ({ mode: room.mode, rec: !!room.rec, people: [...room.people.values()] });
const push = () => { const s = state(); for (const u of room.people.keys()) send(u, { t: "state", s }); };
const auth = (req, res) => {
    const u = (req.body && req.body.uid) || req.query.uid;
    if (!room.people.has(u)) { res.status(401).json({ error: "ادخل الروم أول" }); return null; }
    return u;
};
function recStop() { if (room.rec) { room.rec = null; } }
function drop(uid) {
    if (!room.people.has(uid)) return;
    room.people.delete(uid); pending.delete(uid);
    const r = conns.get(uid); if (r) { try { r.end(); } catch (e) {} } conns.delete(uid);
    if (room.rec && room.rec.uid === uid) recStop();
    if (!room.people.size) room.chat = [];
    push();
}

app.post("/api/join", (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 24);
    if (!name) return res.status(400).json({ error: "اكتب اسمك" });
    const uid = crypto.randomBytes(6).toString("hex");
    const existing = [...room.people.keys()];
    room.people.set(uid, { uid, name, muted: false, joinedAt: Date.now() });
    push();
    res.json({ uid, state: state(), existing, chat: room.chat,
        ice: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }].concat(process.env.TURN_URL ? [{ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" }] : []) });
});
app.get("/api/events", (req, res) => {
    const uid = String(req.query.uid || "");
    if (!room.people.has(uid)) return res.status(401).end();
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders(); conns.set(uid, res);
    (pending.get(uid) || []).forEach(p => res.write("data: " + JSON.stringify(p) + "\n\n")); pending.delete(uid);
    const ka = setInterval(() => res.write(": ka\n\n"), 20000);
    req.on("close", () => { clearInterval(ka); if (conns.get(uid) === res) { conns.delete(uid); setTimeout(() => { if (!conns.has(uid)) drop(uid); }, 8000); } });
});
app.post("/api/signal", (req, res) => { const u = auth(req, res); if (!u) return; if (room.people.has(req.body.to)) send(req.body.to, { t: "signal", from: u, data: req.body.data }); res.json({ ok: true }); });
app.post("/api/leave", (req, res) => { const u = auth(req, res); if (u) drop(u); res.json({ ok: true }); });
// الكل كبار: عندهم كل الصلاحيات (كتم، طرد، أوضاع الروم)
app.post("/api/mode", (req, res) => { if (!auth(req, res)) return; if (["open", "mute"].includes(req.body.mode)) room.mode = req.body.mode; push(); res.json({ ok: true }); });
app.post("/api/mute", (req, res) => { if (!auth(req, res)) return; const p = room.people.get(req.body.target); if (p) { p.muted = !!req.body.on; push(); } res.json({ ok: true }); });
app.post("/api/kick", (req, res) => { if (!auth(req, res)) return; const t = req.body.target; if (room.people.has(t)) { send(t, { t: "kicked" }); setTimeout(() => drop(t), 300); } res.json({ ok: true }); });
app.post("/api/chat", (req, res) => {
    const u = auth(req, res); if (!u) return; const text = String(req.body.text || "").trim().slice(0, 500); if (!text) return res.json({ ok: true });
    const msg = { name: room.people.get(u).name, text, at: Date.now() }; room.chat.push(msg); room.chat = room.chat.slice(-100);
    for (const k of room.people.keys()) send(k, { t: "chat", msg }); res.json({ ok: true });
});
// ---------- تسجيل الروم ----------
app.post("/api/rec/start", (req, res) => {
    const u = auth(req, res); if (!u) return; if (room.rec) return res.json({ ok: false });
    const ext = /mp4/.test(String(req.body.mime)) ? ".m4a" : ".webm", sid = Date.now() + "-" + u + ext;
    room.rec = { sid, uid: u }; fs.writeFileSync(path.join(REC_DIR, sid), ""); push(); res.json({ ok: true, sid });
});
app.post("/api/rec/chunk", express.raw({ type: "*/*", limit: "3mb" }), (req, res) => {
    const sid = path.basename(String(req.query.sid || ""));
    if (!room.rec || room.rec.sid !== sid || room.rec.uid !== req.query.uid || !Buffer.isBuffer(req.body)) return res.status(404).json({ error: "no" });
    fs.appendFileSync(path.join(REC_DIR, sid), req.body); res.json({ ok: true });
});
app.post("/api/rec/stop", (req, res) => { const u = auth(req, res); if (u && room.rec && room.rec.uid === u) { recStop(); push(); } res.json({ ok: true }); });
app.get("/api/rec", (req, res) => res.json(fs.readdirSync(REC_DIR).filter(f => /\.(webm|m4a)$/.test(f)).sort().reverse().map(f => ({ f, at: parseInt(f, 10), kb: Math.round(fs.statSync(path.join(REC_DIR, f)).size / 1024) }))));
app.get("/api/rec/:f", (req, res) => res.sendFile(path.join(REC_DIR, path.basename(req.params.f))));

app.get("/", (req, res) => res.type("html").send(PAGE));
app.listen(PORT, () => console.log("📡 تردد القطاعات شغال على المنفذ " + PORT));

const PAGE = String.raw`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>📡 تردد القطاعات</title>
<style>
:root{--bg1:#0a1628;--bg2:#0d1f3c;--border:rgba(59,130,246,.25);--gold:#3b82f6;--gold-soft:#60a5fa;--green:#1d4ed8;--green2:#3b82f6;--red:#ef4444;--amber:#eab308;--text:#e2e8f0;--muted:#64748b}
*{box-sizing:border-box;margin:0;padding:0;font-family:'Tajawal','Tahoma','Segoe UI',sans-serif}
body{background:linear-gradient(135deg,#0a1628 0%,#0d1f3c 40%,#0a2744 70%,#0d3060 100%);color:var(--text);min-height:100vh}
.btn{border:none;border-radius:8px;padding:.45rem .9rem;font-size:13px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--gold),var(--green))}
.btn.gray{background:rgba(255,255,255,.1)}.btn.red{background:#b91c1c}.btn.sm{padding:.3rem .5rem;font-size:12px}
#login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:linear-gradient(160deg,#0d1f3c,#0a1628);border:1px solid var(--border);border-radius:16px;padding:26px;width:100%;max-width:380px;text-align:center;box-shadow:0 15px 45px rgba(0,0,0,.5)}
.card h1{color:var(--gold-soft);font-size:24px;margin-bottom:6px}.card p{color:var(--muted);font-size:13px;margin-bottom:16px;line-height:1.8}
.card input{width:100%;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:11px 12px;font-size:15px;margin-bottom:12px}
.card .btn{width:100%;padding:12px;font-size:15px}
#room{position:fixed;inset:0;z-index:4000;background:linear-gradient(160deg,#060e1c,#0a1628);overflow-y:auto;padding:14px 14px 120px;display:none}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap}
.head b{color:var(--gold-soft);font-size:17px}.head span{font-size:12px;color:var(--muted)}
.modes{display:flex;gap:8px;margin-bottom:8px}
.mode{flex:1;padding:10px 8px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:#94a3b8;font-size:13px;font-weight:700;cursor:pointer}
.mode.on{background:var(--green2);color:#fff;border-color:var(--green2)}
.note{text-align:center;font-size:13px;color:var(--muted);margin:8px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.tile{background:rgba(255,255,255,.05);border:2px solid transparent;border-radius:14px;padding:14px 8px 10px;text-align:center;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.tile.speaking{border-color:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.25)}
.av{width:56px;height:56px;border-radius:50%;margin:0 auto 8px;background:linear-gradient(135deg,#1d4ed8,#60a5fa);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff}
.nm{font-size:13px;font-weight:700;word-break:break-word}.rl{font-size:11px;color:var(--muted);margin:3px 0}.ic{font-size:16px;min-height:22px}
.tile .btn{margin-top:6px;width:100%}
.bar{position:fixed;bottom:0;left:0;right:0;z-index:4100;display:flex;justify-content:center;align-items:center;gap:12px;padding:14px;background:rgba(5,15,30,.95);border-top:1px solid rgba(59,130,246,.3);flex-wrap:wrap}
.ob{min-width:100px;padding:12px 16px;border-radius:30px;border:1px solid var(--border);background:rgba(255,255,255,.08);color:#fff;font-size:14px;font-weight:700;cursor:pointer}
.ob.leave{background:#ef4444;border-color:#ef4444}
#ptt{min-width:190px;padding:16px 22px;font-size:17px;background:var(--green);border-color:var(--gold-soft);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
#ptt.live{background:#16a34a;border-color:#4ade80;box-shadow:0 0 0 6px rgba(34,197,94,.3)}
.chatbtn{position:fixed;top:10px;left:10px;z-index:4150;padding:11px 20px;border-radius:30px;border:1px solid #60a5fa;background:#1d4ed8;color:#fff;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
.dot{display:inline-block;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:#ef4444;font-size:11px;margin-right:6px;padding:0 5px;text-align:center}
#sheet{position:fixed;left:0;right:0;bottom:0;height:62vh;z-index:4400;background:linear-gradient(160deg,#0d1f3c,#0a1628);border-top:1px solid var(--border);border-radius:18px 18px 0 0;display:none;flex-direction:column;padding:12px}
#sheet.open{display:flex}#cl{flex:1;overflow-y:auto;font-size:13px;line-height:1.9;margin:8px 0}
.ci{display:flex;gap:8px}.ci input{flex:1;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px;font-size:14px}
#recs{position:fixed;inset:0;z-index:4500;background:rgba(5,10,20,.85);display:none;align-items:center;justify-content:center;padding:16px}
#recs>div{background:#0d1f3c;border:1px solid var(--border);border-radius:14px;padding:16px;width:100%;max-width:420px;max-height:80vh;overflow-y:auto}
#recs audio{width:100%;margin:4px 0 10px}
#toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1e293b;border:1px solid var(--border);padding:10px 18px;border-radius:10px;z-index:9000;font-size:14px;display:none}
</style></head><body>
<div id="login"><div class="card"><h1>📡 تردد القطاعات</h1>
<p>موقع تجربة — الكل كبار وعندهم كل الصلاحيات.<br>اكتب اسمك وادخل الروم الصوتي.</p>
<input id="nm" maxlength="24" placeholder="اسمك" onkeydown="if(event.key==='Enter')join()">
<button class="btn" onclick="join()">🎙️ دخول الروم الصوتي</button></div></div>
<div id="room">
<div class="head"><b>📡 تردد القطاعات — الروم الصوتي</b><span id="cnt"></span>
<span><button class="btn gray sm" onclick="showRecs()">📼 التسجيلات</button></span></div>
<div class="modes"><button class="mode" id="m-open" onclick="setMode('open')">🔊 الكل يتكلم ويسمع</button><button class="mode" id="m-mute" onclick="setMode('mute')">🔇 الروم صامت</button></div>
<div class="note" id="note"></div><div class="grid" id="grid"></div>
<div class="bar"><button class="ob" id="ptt">🎙️ اضغط واستمر للتحدث</button><button class="ob" style="background:#334155" onclick="openPip()">🪟 نافذة عائمة</button><button class="ob leave" onclick="leave()">🚪 خروج</button></div>
<button class="chatbtn" onclick="chatToggle()">💬 شات<span id="cd"></span></button>
<div id="sheet"><div style="display:flex;justify-content:space-between;align-items:center"><b style="color:var(--gold-soft)">💬 الشات</b><button class="btn gray sm" onclick="chatToggle()">↩️ رجوع للروم</button></div>
<div id="cl"></div><div class="ci"><input id="ci" maxlength="500" placeholder="اكتب رابط أو تعليمات أو سؤال..." onkeydown="if(event.key==='Enter')chatSend()"><button class="btn" onclick="chatSend()">إرسال</button></div></div>
<div id="aud" style="display:none"></div></div>
<div id="recs" onclick="if(event.target===this)this.style.display='none'"><div><b style="color:var(--gold-soft)">📼 تسجيلات الروم</b><div id="rl" style="margin-top:10px"></div></div></div>
<div id="toast"></div>
<script>
var ME=null,S=null,ICE=[],P={},stream,mic,ev,ac,rdest,speaking={},an={},unread=0,pttOn=false,rec=null,recBusy=false,pipWin=null,pipV=null,pipC=null;
function $(i){return document.getElementById(i)}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function toast(m){var t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(function(){t.style.display='none'},2800)}
function api(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({uid:ME&&ME.uid},b||{}))}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'خطأ');return d})})}
function who(u){return S.people.filter(function(p){return p.uid===u})[0]}
async function join(){
 var name=$('nm').value.trim();if(!name)return toast('اكتب اسمك');
 if(!window.RTCPeerConnection||!navigator.mediaDevices)return toast('المتصفح ما يدعم الصوت (لازم HTTPS)');
 try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})}catch(e){return toast('اسمح للموقع باستخدام المايك')}
 mic=stream.getAudioTracks()[0];mic.enabled=false;
 try{ME=await api('/api/join',{name:name})}catch(e){return toast(e.message)}
 S=ME.state;ICE=ME.ice;
 ac=new(window.AudioContext||window.webkitAudioContext)();ac.resume();rdest=ac.createMediaStreamDestination();
 ac.createMediaStreamSource(stream).connect(rdest);
 $('login').style.display='none';$('room').style.display='block';document.body.style.overflow='hidden';
 watch(ME.uid,stream);ME.chat.forEach(addChat);
 ev=new EventSource('/api/events?uid='+ME.uid);ev.onmessage=function(e){onMsg(JSON.parse(e.data))};
 ME.existing.forEach(function(u){peer(u,true)});
 bind($('ptt'));paint();pipSetup();setInterval(level,150);
}
function onMsg(m){
 if(m.t==='state'){S=m.s;Object.keys(P).forEach(function(u){if(!who(u)){P[u].pc.close();P[u].el.remove();delete P[u]}});paint();recCheck()}
 else if(m.t==='signal')onSignal(m.from,m.data);
 else if(m.t==='chat'){addChat(m.msg);if(!$('sheet').classList.contains('open')){unread++;$('cd').innerHTML='<span class="dot">'+unread+'</span>'}}
 else if(m.t==='kicked'){toast('تم طردك من الروم');leave(true)}
}
function sig(to,data){api('/api/signal',{to:to,data:data}).catch(function(){})}
function peer(uid,init){
 var pc=new RTCPeerConnection({iceServers:ICE}),p={uid:uid,pc:pc,el:document.createElement('audio'),pend:[],ready:false};
 p.el.autoplay=true;p.el.setAttribute('playsinline','');$('aud').appendChild(p.el);
 stream.getTracks().forEach(function(t){pc.addTrack(t,stream)});
 pc.onicecandidate=function(e){if(e.candidate)sig(uid,{ice:e.candidate})};
 pc.ontrack=function(e){p.stream=e.streams[0]||new MediaStream([e.track]);p.el.srcObject=p.stream;p.el.play().catch(function(){});
  watch(uid,p.stream);try{ac.createMediaStreamSource(p.stream).connect(rdest)}catch(x){}applyMute()};
 P[uid]=p;
 if(init)pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){sig(uid,{sdp:pc.localDescription})});
 return p;
}
async function onSignal(from,d){
 var p=P[from]||peer(from,false);
 if(d.sdp){await p.pc.setRemoteDescription(d.sdp);p.ready=true;p.pend.forEach(function(c){p.pc.addIceCandidate(c).catch(function(){})});p.pend=[];
  if(d.sdp.type==='offer'){var a=await p.pc.createAnswer();await p.pc.setLocalDescription(a);sig(from,{sdp:p.pc.localDescription})}}
 else if(d.ice){p.ready?p.pc.addIceCandidate(d.ice).catch(function(){}):p.pend.push(d.ice)}
}
function applyMute(){Object.keys(P).forEach(function(u){var w=who(u);P[u].el.muted=!w||w.muted||S.mode==='mute'})}
/* ---------- المايك: اضغط واستمر ---------- */
function ptt(on){
 if(on){var me=who(ME.uid);if(me&&me.muted)return toast('أحد الكبار كاتم المايك عنك');if(S.mode==='mute')return toast('الروم صامت')}
 mic.enabled=on;pttOn=on;pttPaint();
}
function bind(b){
 b.addEventListener('pointerdown',function(e){e.preventDefault();try{b.setPointerCapture(e.pointerId)}catch(x){}ptt(true)});
 ['pointerup','pointercancel','lostpointercapture'].forEach(function(n){b.addEventListener(n,function(){ptt(false)})});
 b.addEventListener('contextmenu',function(e){e.preventDefault()});
}
document.addEventListener('keydown',function(e){if(e.code==='Space'&&ME&&!e.repeat&&e.target.tagName!=='INPUT'){e.preventDefault();ptt(true)}});
document.addEventListener('keyup',function(e){if(e.code==='Space'&&ME)ptt(false)});
function pttPaint(){
 var b=$('ptt');b.classList.toggle('live',pttOn);b.textContent=pttOn?'🟢 تتكلم الحين... (فك لإيقاف المايك)':'🎙️ اضغط واستمر للتحدث';
 if(pipWin){var pb=pipWin.document.getElementById('pb');if(pb){pb.style.background=pttOn?'#16a34a':'#1d4ed8';pb.innerHTML=pttOn?'🟢<br>تتكلم...':'🎙️<br>اضغط واستمر'}}
 pipDraw();
}
/* ---------- النافذة العائمة فوق يمين ---------- */
var pipBusy=false,pipTimer=null;
function pipClean(){
 if(pipTimer){clearInterval(pipTimer);pipTimer=null}
 if(pipV){try{if(pipV.webkitPresentationMode==='picture-in-picture')pipV.webkitSetPresentationMode('inline')}catch(e){}try{pipV.pause();pipV.srcObject=null;pipV.remove()}catch(e){}}
 pipV=null;pipC=null;pipBusy=false;
}
function pipFail(auto,e){
 pipClean();
 if(!auto)toast('تعذر فتح النافذة العائمة'+(e&&e.name?' ('+e.name+')':''));
}
async function openPip(auto){
 auto=(auto===true);
 if(pipWin||pipV||pipBusy)return;
 pipBusy=true;
 try{
  if(window.documentPictureInPicture){
   var w=null;
   try{w=await documentPictureInPicture.requestWindow({width:300,height:300})}catch(e){w=null}
   if(w){
    pipWin=w;
    try{pipWin.moveTo(screen.availLeft+screen.availWidth-320,screen.availTop+10)}catch(e){}
    var d=pipWin.document;d.body.style.cssText='margin:0;background:#0a1628;display:flex;align-items:center;justify-content:center;overflow:hidden;direction:rtl;font-family:Tahoma,sans-serif';
    d.body.innerHTML='<button id="pb" style="width:240px;height:240px;border-radius:50%;border:5px solid #60a5fa;background:#1d4ed8;color:#fff;font-size:24px;font-weight:800;touch-action:none;user-select:none;cursor:pointer">🎙️<br>اضغط واستمر</button>';
    bind(d.getElementById('pb'));
    pipWin.addEventListener('pagehide',function(){pipWin=null;ptt(false)});
    pipBusy=false;return;
   }
   if(auto){pipBusy=false;return}
  }
  await pipFallback(auto);
 }catch(e){pipFail(auto,e)}
 pipBusy=false;
}
function pipDraw(){
 if(!pipC)return;var x=pipC.getContext('2d');x.fillStyle=pttOn?'#16a34a':'#1d4ed8';x.fillRect(0,0,320,320);
 x.fillStyle='#fff';x.font='bold 30px Tahoma';x.textAlign='center';x.fillText(pttOn?'🟢 المايك شغال':'🎙️ المايك مقفل',160,160);x.font='18px Tahoma';x.fillText('زر التشغيل = تكلم / إيقاف = اقفل',160,210);
}
async function pipFallback(auto){ /* سفاري وغيره: فيديو عائم + أزرار التشغيل/الإيقاف (ضغطة تشغّل وضغطة تقفل، ما فيه ضغط مستمر) */
 var v=document.createElement('video');
 var stdPip=!!(document.pictureInPictureEnabled&&v.requestPictureInPicture),wkPip=(typeof v.webkitSetPresentationMode==='function');
 if(!stdPip&&!wkPip){if(!auto)toast('هذا المتصفح ما يدعم النافذة العائمة — استخدم Chrome أو Edge');return}
 var c=document.createElement('canvas');c.width=c.height=320;pipC=c;pipDraw();
 v.muted=true;v.playsInline=true;v.setAttribute('playsinline','');v.setAttribute('webkit-playsinline','');
 v.style.cssText='position:fixed;right:0;bottom:0;width:160px;height:160px;opacity:0.01;pointer-events:none;z-index:-1';
 v.srcObject=c.captureStream(10);document.body.appendChild(v);
 pipTimer=setInterval(pipDraw,500); /* يبقي الفريمات تنزل للفيديو عشان ما يعلق */
 try{navigator.mediaSession.setActionHandler('play',function(){ptt(true)});navigator.mediaSession.setActionHandler('pause',function(){ptt(false)})}catch(e){}
 await Promise.race([v.play(),new Promise(function(r,j){setTimeout(function(){j(new Error('timeout'))},3000)})]);
 if(v.readyState<1)await new Promise(function(r){v.addEventListener('loadedmetadata',r,{once:true});setTimeout(r,1500)});
 if(stdPip){await v.requestPictureInPicture();v.addEventListener('leavepictureinpicture',function(){pipClean();ptt(false)})}
 else{ /* سفاري آيفون */
  v.webkitSetPresentationMode('picture-in-picture');
  v.addEventListener('webkitpresentationmodechanged',function(){if(v.webkitPresentationMode!=='picture-in-picture'){pipClean();ptt(false)}});
 }
 pipV=v;
}
function pipSetup(){
 try{navigator.mediaSession.metadata=new MediaMetadata({title:'تردد القطاعات — الروم الصوتي'});navigator.mediaSession.playbackState='playing';
  navigator.mediaSession.setActionHandler('enterpictureinpicture',function(){openPip(true)})}catch(e){}
 /* فتح تلقائي صامت عند الطلعة من الصفحة (المتصفح يمنعه بدون لمسة، فلو فشل ما يطلع أي رسالة) */
 document.addEventListener('visibilitychange',function(){if(document.hidden&&ME&&navigator.userActivation&&navigator.userActivation.isActive)openPip(true)});
}
/* ---------- الواجهة ---------- */
function paint(){
 if(!S)return;var me=who(ME.uid);
 $('cnt').textContent='👥 '+S.people.length+' داخل الروم'+(S.rec?' · 🔴 الروم مسجّل':'');
 $('m-open').classList.toggle('on',S.mode==='open');$('m-mute').classList.toggle('on',S.mode==='mute');
 $('note').textContent=S.mode==='open'?'الكل يتكلم ويسمع. اضغط واستمر على زر المايك للتحدث.':'الروم صامت، محد يتكلم.';
 $('grid').innerHTML=S.people.map(function(p){var self=p.uid===ME.uid;
  return '<div class="tile'+''+(speaking[p.uid]?' speaking':'')+'" id="t-'+p.uid+'" onclick="pick(\''+p.uid+'\')"><div class="av">'+esc(p.name.charAt(0))+'</div><div class="nm">'+esc(p.name)+(self?' (أنت)':'')+'</div><div class="rl">⭐ كبير</div><div class="ic">'+(p.muted?'🔇':'🎙️')+'</div>'
  +'<button class="btn sm gray" onclick="event.stopPropagation();mute(\''+p.uid+'\','+!p.muted+')">'+(p.muted?'🔊 فك الكتم':'🔇 كتم')+'</button>'
  +(self?'':'<button class="btn sm red" onclick="event.stopPropagation();kick(\''+p.uid+'\')">🚪 طرد</button>')+'</div>'}).join('');
 applyMute();pttPaint();
}
function setMode(m){api('/api/mode',{mode:m}).catch(function(e){toast(e.message)})}
function mute(t,on){api('/api/mute',{target:t,on:on}).catch(function(e){toast(e.message)})}
function kick(t){if(confirm('تطرد هذا الشخص؟'))api('/api/kick',{target:t}).catch(function(e){toast(e.message)})}
/* كشف الكلام */
function watch(uid,st){try{var a=ac.createAnalyser();a.fftSize=256;ac.createMediaStreamSource(st).connect(a);an[uid]={a:a,b:new Uint8Array(a.fftSize)}}catch(e){}}
function level(){Object.keys(an).forEach(function(u){var o=an[u];o.a.getByteTimeDomainData(o.b);var s=0;for(var i=0;i<o.b.length;i++){var v=(o.b[i]-128)/128;s+=v*v}var on=Math.sqrt(s/o.b.length)>0.03;if(on!==!!speaking[u]){speaking[u]=on;var t=$('t-'+u);if(t)t.classList.toggle('speaking',on)}})}
/* الشات */
function addChat(m){var d=document.createElement('div');d.innerHTML='<b style="color:var(--gold-soft)">'+esc(m.name)+':</b> '+esc(m.text).replace(/(https?:\/\/[^\s]+)/g,'<a href="$1" target="_blank" style="color:#93c5fd">$1</a>');$('cl').appendChild(d);$('cl').scrollTop=1e9}
function chatToggle(){var s=$('sheet');s.classList.toggle('open');if(s.classList.contains('open')){unread=0;$('cd').innerHTML=''}}
function chatSend(){var i=$('ci'),t=i.value.trim();if(!t)return;i.value='';api('/api/chat',{text:t}).catch(function(e){toast(e.message)})}
/* تسجيل الروم (يبدأ تلقائي لما يكون فيه شخصين فأكثر) */
function recMime(){var c=['audio/webm;codecs=opus','audio/webm','audio/mp4'];for(var i=0;i<c.length;i++){try{if(MediaRecorder.isTypeSupported(c[i]))return c[i]}catch(e){}}return''}
function recCheck(){
 if(!window.MediaRecorder)return;
 if(rec){if(S.people.length<2)recStop();return}
 if(S.people.length<2||S.rec||recBusy)return;recBusy=true;
 api('/api/rec/start',{mime:recMime()}).then(function(r){recBusy=false;if(!r.ok)return;
  var mr=new MediaRecorder(rdest.stream,recMime()?{mimeType:recMime()}:{}),q=Promise.resolve();rec={mr:mr,sid:r.sid};
  mr.ondataavailable=function(e){if(!e.data.size)return;q=q.then(function(){return fetch('/api/rec/chunk?uid='+ME.uid+'&sid='+encodeURIComponent(r.sid),{method:'POST',body:e.data})}).catch(function(){})};
  mr.start(4000)}).catch(function(){recBusy=false});
}
function recStop(){if(!rec)return;var r=rec;rec=null;try{r.mr.stop()}catch(e){}setTimeout(function(){api('/api/rec/stop',{}).catch(function(){})},1500)}
function showRecs(){
 $('recs').style.display='flex';$('rl').textContent='...';
 fetch('/api/rec').then(function(r){return r.json()}).then(function(l){$('rl').innerHTML=l.length?l.map(function(x){return '<div>🕒 '+new Date(x.at).toLocaleString('ar-SA')+' — '+x.kb+' ك.ب<audio controls preload="none" src="/api/rec/'+encodeURIComponent(x.f)+'"></audio></div>'}).join(''):'ما فيه تسجيلات للحين.'});
}
function leave(k){
 recStop();if(ev)ev.close();Object.keys(P).forEach(function(u){P[u].pc.close()});
 if(!k&&ME)navigator.sendBeacon('/api/leave',new Blob([JSON.stringify({uid:ME.uid})],{type:'application/json'}));
 try{stream.getTracks().forEach(function(t){t.stop()})}catch(e){}
 if(pipWin)try{pipWin.close()}catch(e){}try{if(document.pictureInPictureElement)document.exitPictureInPicture()}catch(e){}pipClean();
 setTimeout(function(){location.reload()},300);
}
window.addEventListener('pagehide',function(){if(ME&&!ME.left&&false)leave()});
</script></body></html>`;
