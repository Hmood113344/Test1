// ============================================================
//  موقع تردد القطاعات المشتركة — ملف مستقل
//  التشغيل:
//     npm install express ws
//     node app_frequency.js
//  المتغيرات (اختيارية):  PORT=3000  FREQUENCY="123.45"  TURN_URL / TURN_USER / TURN_PASS
// ============================================================
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// ⚙️ غيّر التردد من هنا (أو من متغير FREQUENCY)
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SITE_NAME: "فلاش",
    TITLE: "تردد القطاعات المشتركة",
    FREQUENCY: process.env.FREQUENCY || "000.00",
    MAX_USERS: 25,
};

function iceServers() {
    const arr = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    if (process.env.TURN_URL) {
        arr.push({
            urls: String(process.env.TURN_URL).split(",").map(x => x.trim()).filter(Boolean),
            username: process.env.TURN_USER || "",
            credential: process.env.TURN_PASS || "",
        });
    }
    return arr;
}

// ---------------- الصفحة ----------------
const PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a1628">
<title>__TITLE__ — __SITE__</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
    :root {
        --bg1: #0a1628; --bg2: #0d1f3c; --panel: rgba(255,255,255,0.04); --border: rgba(59,130,246,0.25);
        --gold: #3b82f6; --gold-soft: #60a5fa; --green: #1d4ed8; --green2: #3b82f6;
        --red: #ef4444; --amber: #eab308; --text: #e2e8f0; --muted: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Tajawal', 'Tahoma', 'Segoe UI', sans-serif; }
    html, body { min-height: 100vh; min-height: 100dvh; }
    body { background: linear-gradient(135deg, #0a1628 0%, #0d1f3c 40%, #0a2744 70%, #0d3060 100%); color: var(--text); }
    .logo { font-size: 1.3rem; font-weight: 900; background: linear-gradient(90deg, #3b82f6, #60a5fa, #93c5fd); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: 2px; }

    /* ---------- شاشة الدخول ---------- */
    #home { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px 16px;
            background: radial-gradient(circle at 50% 38%, rgba(18,48,94,0.9) 0%, rgba(10,22,40,0) 62%); }
    .card { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 30px 22px 26px;
            text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5); backdrop-filter: blur(6px); animation: pop .35s ease; }
    @keyframes pop { from { transform: translateY(10px) scale(0.97); opacity: 0; } to { transform: none; opacity: 1; } }
    .radio-ic { width: 84px; height: 84px; margin: 16px auto 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
                background: linear-gradient(135deg, #1d4ed8, #60a5fa); box-shadow: 0 0 28px rgba(59,130,246,0.55); }
    .radio-ic svg { width: 42px; height: 42px; }
    .card h1 { font-size: 24px; font-weight: 800; color: var(--gold-soft); margin: 10px 0 4px; }
    .card .sub { font-size: 13px; color: var(--muted); margin-bottom: 18px; }
    .freq { direction: ltr; display: inline-block; min-width: 70%; padding: 12px 20px; border-radius: 14px; border: 1px solid var(--border);
            background: rgba(5,15,30,0.7); font-size: 40px; font-weight: 800; letter-spacing: 3px; color: #e2e8f0;
            text-shadow: 0 0 18px rgba(59,130,246,0.7); font-variant-numeric: tabular-nums; }
    .freq-lbl { font-size: 12px; color: var(--muted); margin-top: 8px; letter-spacing: 1px; }
    .btn { display: block; width: 100%; margin-top: 22px; background: linear-gradient(135deg, var(--green), var(--green2)); color: #fff; border: none;
           border-radius: 10px; padding: 14px 20px; font-size: 17px; font-weight: 800; cursor: pointer; transition: 0.2s; }
    .btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .btn:active { transform: scale(0.98); }
    .btn[disabled] { opacity: 0.5; pointer-events: none; }

    /* ---------- نافذة الاسم ---------- */
    #nm-overlay { position: fixed; inset: 0; background: rgba(5,10,20,0.72); backdrop-filter: blur(3px); z-index: 7000; display: none; align-items: center; justify-content: center; padding: 16px; }
    #nm-overlay.open { display: flex; }
    #nm-box { background: linear-gradient(160deg, #0d1f3c, #0a1628); border: 1px solid var(--border); border-radius: 14px; width: 100%; max-width: 380px; padding: 20px; box-shadow: 0 15px 45px rgba(0,0,0,0.5); }
    #nm-box p { font-size: 15px; margin-bottom: 12px; }
    #nm-input { width: 100%; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 11px 12px; font-size: 15px; margin-bottom: 4px; font-family: inherit; }
    #nm-input:focus { outline: none; border-color: var(--gold-soft); }
    #nm-box .btn { margin-top: 12px; padding: 11px 16px; font-size: 15px; }

    /* ---------- داخل التردد ---------- */
    #room { position: fixed; inset: 0; z-index: 4000; display: none; flex-direction: column; background: linear-gradient(160deg, #060e1c, #0a1628); overflow-y: auto; padding: 14px; }
    #room.open { display: flex; }
    .r-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(59,130,246,0.25); gap: 10px; }
    .r-head b { color: var(--gold-soft); font-size: 17px; }
    .r-head .f { direction: ltr; font-weight: 800; color: #e2e8f0; letter-spacing: 2px; text-shadow: 0 0 12px rgba(59,130,246,0.7); }
    .r-head .cnt { font-size: 12px; color: var(--muted); }
    .live-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; margin-inline-end: 6px; box-shadow: 0 0 8px #22c55e; animation: blink 1.6s infinite; }
    @keyframes blink { 50% { opacity: 0.35; } }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .tile { background: rgba(255,255,255,0.05); border: 2px solid transparent; border-radius: 14px; padding: 14px 8px 12px; text-align: center; transition: border-color 0.15s, box-shadow 0.15s; }
    .tile.speaking { border-color: #22c55e; box-shadow: 0 0 14px rgba(34,197,94,0.55); }
    .av { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 8px; background: linear-gradient(135deg, #1d4ed8, #60a5fa); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; color: #fff; }
    .nm { font-size: 13px; font-weight: 700; word-break: break-word; }
    .me { font-size: 11px; color: var(--gold-soft); margin-top: 3px; }
    #toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: #0b1730; border: 1px solid var(--border); color: var(--text); padding: 10px 18px; border-radius: 10px; font-size: 14px; z-index: 9000; display: none; max-width: 90vw; text-align: center; }
</style>
</head>
<body>

<div id="home">
    <div class="card">
        <div class="logo">__SITE__</div>
        <div class="radio-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2v10"/><path d="M8 6a6 6 0 0 0 0 8"/><path d="M16 6a6 6 0 0 1 0 8"/><path d="M5 3a10 10 0 0 0 0 14"/><path d="M19 3a10 10 0 0 1 0 14"/><circle cx="12" cy="18" r="3"/>
            </svg>
        </div>
        <h1>__TITLE__</h1>
        <div class="sub">القناة الصوتية المشتركة بين جميع القطاعات</div>
        <div class="freq">__FREQ__</div>
        <div class="freq-lbl">FREQUENCY</div>
        <button class="btn" id="enter-btn">🎙️ دخول</button>
    </div>
</div>

<div id="nm-overlay">
    <div id="nm-box">
        <p>اكتب اسمك اللي يظهر للكل داخل التردد:</p>
        <input id="nm-input" maxlength="24" placeholder="الاسم" autocomplete="off">
        <button class="btn" id="nm-ok">متابعة</button>
    </div>
</div>

<div id="room">
    <div class="r-head">
        <div><span class="live-dot"></span><b>__TITLE__</b></div>
        <div style="text-align:left;"><div class="f">__FREQ__</div><div class="cnt" id="cnt"></div></div>
    </div>
    <div id="grid" class="grid"></div>
    <div id="audio" style="display:none"></div>
</div>
<div id="toast"></div>

<script>
(function () {
    var FREQ = "__FREQ__";
    var $ = function (id) { return document.getElementById(id); };
    var S = null; // حالة الجلسة

    function toast(t) {
        var el = $('toast'); el.textContent = t; el.style.display = 'block';
        clearTimeout(toast._t); toast._t = setTimeout(function () { el.style.display = 'none'; }, 3500);
    }
    function getName() { try { return localStorage.getItem('fq_name') || ''; } catch (e) { return ''; } }
    function setName(n) { try { localStorage.setItem('fq_name', n); } catch (e) {} }

    $('enter-btn').onclick = function () {
        var n = getName();
        if (n) return join(n);
        $('nm-overlay').classList.add('open');
        setTimeout(function () { $('nm-input').focus(); }, 50);
    };
    function submitName() {
        var n = $('nm-input').value.trim().slice(0, 24);
        if (!n) { $('nm-input').focus(); return; }
        setName(n);
        $('nm-overlay').classList.remove('open');
        join(n);
    }
    $('nm-ok').onclick = submitName;
    $('nm-input').onkeydown = function (e) { if (e.key === 'Enter') submitName(); };

    async function join(name) {
        if (S) return;
        if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast('متصفحك لا يدعم الصوت، استخدم Chrome أو Safari حديث'); return;
        }
        var btn = $('enter-btn'); btn.disabled = true;
        var stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch (e) { btn.disabled = false; toast('تعذر تشغيل المايك — اسمح للموقع باستخدام المايك'); return; }

        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var ws = new WebSocket(proto + location.host + '/ws');
        S = { ws: ws, stream: stream, id: null, name: name, ice: [], peers: {}, users: {}, speaking: {}, ac: null, closed: false };
        ws.onopen = function () { ws.send(JSON.stringify({ t: 'join', name: name })); };
        ws.onmessage = function (e) { var d; try { d = JSON.parse(e.data); } catch (x) { return; } onMsg(d); };
        ws.onclose = function () { if (S && !S.closed) leave('انقطع الاتصال'); };
        ws.onerror = function () {};
    }

    function leave(msg) {
        if (!S) return;
        var s = S; s.closed = true; S = null;
        Object.keys(s.peers).forEach(function (id) { closePeer(s, id); });
        try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        try { s.ws.close(); } catch (e) {}
        try { if (s.ac) s.ac.close(); } catch (e) {}
        clearInterval(s.timer);
        $('room').classList.remove('open');
        document.body.style.overflow = '';
        $('enter-btn').disabled = false;
        if (msg) toast(msg);
    }

    function send(o) { if (S && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

    function onMsg(d) {
        if (!S) return;
        if (d.t === 'full') { leave('التردد ممتلئ حالياً، حاول بعد شوي'); return; }
        if (d.t === 'welcome') {
            S.id = d.id; S.ice = d.ice || [];
            S.users[S.id] = { name: S.name };
            (d.peers || []).forEach(function (p) { S.users[p.id] = { name: p.name }; });
            $('room').classList.add('open');
            document.body.style.overflow = 'hidden';
            watch(S.id, S.stream);
            // القادم الجديد هو اللي يبدأ الاتصال مع الموجودين
            (d.peers || []).forEach(function (p) { var P = makePeer(p.id); startOffer(P); });
            S.timer = setInterval(paintSpeaking, 150);
            paint();
        } else if (d.t === 'joined') {
            S.users[d.id] = { name: d.name }; paint();
        } else if (d.t === 'left') {
            closePeer(S, d.id); delete S.users[d.id]; delete S.speaking[d.id]; paint();
        } else if (d.t === 'signal') {
            onSignal(d.from, d.data);
        }
    }

    // ---------- WebRTC (شبكة mesh صوتية) ----------
    function makePeer(id) {
        var s = S;
        var pc = new RTCPeerConnection({ iceServers: s.ice });
        var P = { id: id, pc: pc, audio: document.createElement('audio'), pending: [] };
        P.audio.autoplay = true; P.audio.setAttribute('playsinline', '');
        $('audio').appendChild(P.audio);
        s.peers[id] = P;
        s.stream.getAudioTracks().forEach(function (t) { pc.addTrack(t, s.stream); });
        pc.onicecandidate = function (e) { if (e.candidate && S === s) send({ t: 'signal', to: id, data: { ice: e.candidate } }); };
        pc.ontrack = function (e) {
            if (S !== s) return;
            var st = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
            P.audio.srcObject = st;
            var pp = P.audio.play(); if (pp && pp.catch) pp.catch(function () {});
            watch(id, st);
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === 'failed' && S === s && P.initiator) startOffer(P, true);
        };
        return P;
    }
    async function startOffer(P, restart) {
        P.initiator = true;
        try {
            var o = await P.pc.createOffer(restart ? { iceRestart: true } : undefined);
            await P.pc.setLocalDescription(o);
            send({ t: 'signal', to: P.id, data: { sdp: P.pc.localDescription } });
        } catch (e) {}
    }
    async function flush(P) {
        var l = P.pending; P.pending = [];
        for (var i = 0; i < l.length; i++) { try { await P.pc.addIceCandidate(l[i]); } catch (e) {} }
    }
    async function onSignal(from, data) {
        var s = S; if (!s || !data) return;
        var P = s.peers[from];
        try {
            if (data.sdp) {
                if (data.sdp.type === 'offer') {
                    if (!P) P = makePeer(from);
                    await P.pc.setRemoteDescription(data.sdp);
                    await flush(P);
                    var ans = await P.pc.createAnswer();
                    await P.pc.setLocalDescription(ans);
                    send({ t: 'signal', to: from, data: { sdp: P.pc.localDescription } });
                } else if (data.sdp.type === 'answer' && P) {
                    await P.pc.setRemoteDescription(data.sdp);
                    await flush(P);
                }
            } else if (data.ice) {
                if (!P) { return; }
                if (P.pc.remoteDescription) { try { await P.pc.addIceCandidate(data.ice); } catch (e) {} }
                else P.pending.push(data.ice);
            }
        } catch (e) {}
    }
    function closePeer(s, id) {
        var P = s.peers[id]; if (!P) return;
        try { P.pc.close(); } catch (e) {}
        if (P.audio && P.audio.parentNode) P.audio.parentNode.removeChild(P.audio);
        if (P.an) { try { P.an.src.disconnect(); } catch (e) {} }
        delete s.peers[id];
    }

    // ---------- كشف من يتكلم ----------
    var AN = {};
    function watch(id, stream) {
        var s = S; if (!s) return;
        try {
            if (!s.ac) s.ac = new (window.AudioContext || window.webkitAudioContext)();
            var src = s.ac.createMediaStreamSource(stream);
            var an = s.ac.createAnalyser(); an.fftSize = 512;
            src.connect(an);
            var buf = new Uint8Array(an.fftSize);
            s['an_' + id] = { an: an, buf: buf, src: src };
        } catch (e) {}
    }
    function paintSpeaking() {
        var s = S; if (!s) return;
        var changed = false;
        Object.keys(s.users).forEach(function (id) {
            var a = s['an_' + id]; if (!a) return;
            a.an.getByteTimeDomainData(a.buf);
            var m = 0;
            for (var i = 0; i < a.buf.length; i++) { var v = Math.abs(a.buf[i] - 128); if (v > m) m = v; }
            var on = m > 14;
            if (!!s.speaking[id] !== on) { s.speaking[id] = on; changed = true;
                var el = document.querySelector('[data-id="' + id + '"]'); if (el) el.classList.toggle('speaking', on); }
        });
    }

    // ---------- الواجهة ----------
    function paint() {
        var s = S; if (!s) return;
        var ids = Object.keys(s.users);
        $('cnt').textContent = ids.length + ' متصل';
        var g = $('grid'); g.innerHTML = '';
        ids.forEach(function (id) {
            var u = s.users[id];
            var t = document.createElement('div'); t.className = 'tile' + (s.speaking[id] ? ' speaking' : ''); t.setAttribute('data-id', id);
            var av = document.createElement('div'); av.className = 'av'; av.textContent = (u.name || '?').trim().charAt(0).toUpperCase();
            var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = u.name;
            t.appendChild(av); t.appendChild(nm);
            if (id === s.id) { var me = document.createElement('div'); me.className = 'me'; me.textContent = '(أنت)'; t.appendChild(me); }
            g.appendChild(t);
        });
    }
    window.addEventListener('beforeunload', function () { if (S) { try { S.ws.close(); } catch (e) {} } });
})();
</script>
</body>
</html>`;

// ---------------- السيرفر ----------------
const app = express();
app.disable("x-powered-by");
const html = PAGE
    .replace(/__TITLE__/g, CONFIG.TITLE)
    .replace(/__SITE__/g, CONFIG.SITE_NAME)
    .replace(/__FREQ__/g, String(CONFIG.FREQUENCY).replace(/[<>&"']/g, ""));
app.get("/", (req, res) => { res.set("Cache-Control", "no-store").type("html").send(html); });
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
const users = new Map(); // id -> { ws, name, alive }

function sendTo(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
    for (const [id, u] of users) if (id !== exceptId) sendTo(u.ws, obj);
}

wss.on("connection", (ws) => {
    let myId = null;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
        let d; try { d = JSON.parse(raw); } catch (e) { return; }
        if (!d || typeof d !== "object") return;

        if (d.t === "join" && !myId) {
            if (users.size >= CONFIG.MAX_USERS) { sendTo(ws, { t: "full" }); return ws.close(); }
            const name = String(d.name || "").replace(/\s+/g, " ").trim().slice(0, 24) || "مجهول";
            myId = crypto.randomBytes(6).toString("hex");
            const peers = Array.from(users, ([id, u]) => ({ id, name: u.name }));
            users.set(myId, { ws, name });
            sendTo(ws, { t: "welcome", id: myId, ice: iceServers(), peers });
            broadcast({ t: "joined", id: myId, name }, myId);
        } else if (d.t === "signal" && myId) {
            const target = users.get(String(d.to));
            if (target) sendTo(target.ws, { t: "signal", from: myId, data: d.data });
        }
    });

    ws.on("close", () => {
        if (myId && users.get(myId) && users.get(myId).ws === ws) {
            users.delete(myId);
            broadcast({ t: "left", id: myId });
        }
    });
    ws.on("error", () => {});
});

// فصل الاتصالات الميتة
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    });
}, 25000);

server.listen(CONFIG.PORT, () => console.log("📻 موقع التردد شغال على المنفذ " + CONFIG.PORT));
