// ============================================================
//  فلاش | موقع تجربة الإشعارات (Web Push)
//  التشغيل:  npm install   ثم   node app.js
// ============================================================
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 7800;
const VAPID_FILE = path.join(__dirname, "vapid.json");
const DEV_FILE = path.join(__dirname, "devices.json");

/* ---------- مفاتيح VAPID ---------- */
let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
    try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); }
    catch (e) {
        vapid = webpush.generateVAPIDKeys();
        try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); } catch (_) {}
        console.log("🔑 تم توليد مفاتيح VAPID جديدة. على Render حطها في Environment عشان ما تتغير بعد كل ريستارت:");
        console.log("VAPID_PUBLIC_KEY=" + vapid.publicKey);
        console.log("VAPID_PRIVATE_KEY=" + vapid.privateKey);
    }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", vapid.publicKey, vapid.privateKey);

/* ---------- الأجهزة ---------- */
const devices = new Map(); // id -> { id, name, standalone, sub, lastSeen, createdAt }
try {
    const saved = JSON.parse(fs.readFileSync(DEV_FILE, "utf8"));
    for (const d of saved) devices.set(d.id, d);
} catch (e) {}
let saveTimer = null;
function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try { fs.writeFileSync(DEV_FILE, JSON.stringify([...devices.values()])); } catch (e) {}
    }, 500);
}

const conns = new Map();      // id -> Set(res)  (الصفحة مفتوحة)
const pendingOff = new Set(); // فترة سماح قصيرة عند عمل ريفريش
const streams = new Set();    // كل اتصالات SSE

const validId = v => typeof v === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(v);
const cleanName = v => String(v || "جهاز").replace(/[\r\n<>]/g, "").slice(0, 40);
const isOnline = id => (conns.get(id) && conns.get(id).size > 0) || pendingOff.has(id);

function publicList() {
    return [...devices.values()].map(d => ({
        id: d.id, name: d.name, standalone: !!d.standalone,
        online: isOnline(d.id), push: !!d.sub, lastSeen: d.lastSeen,
    })).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
}
function broadcast() {
    const payload = "event: devices\ndata: " + JSON.stringify(publicList()) + "\n\n";
    for (const s of streams) { try { s.write(payload); } catch (e) { streams.delete(s); } }
}
function upsert(id, name, standalone) {
    let d = devices.get(id);
    if (!d) { d = { id, createdAt: Date.now(), sub: null }; devices.set(id, d); }
    d.name = cleanName(name); d.standalone = !!standalone; d.lastSeen = Date.now();
    saveSoon();
    return d;
}

/* ---------- أيقونات PNG (بدون ملفات خارجية) ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const BOLT = [[58, 8], [26, 55], [46, 55], [40, 92], [74, 42], [54, 42], [64, 8]].map(p => [p[0] / 100, p[1] / 100]);
function inPoly(x, y, poly) {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
}
function makeIcon(size) {
    const S = 2, stride = size * 3 + 1, raw = Buffer.alloc(stride * size);
    const poly = BOLT.map(p => [0.5 + (p[0] - 0.5) * 0.74, 0.5 + (p[1] - 0.5) * 0.74]);
    const mix = (a, b, t) => a + (b - a) * t;
    for (let y = 0; y < size; y++) {
        const ty = y / size;
        const bg = [mix(15, 10, ty), mix(37, 22, ty), mix(71, 40, ty)];
        const bl = [mix(96, 29, ty), mix(165, 78, ty), mix(250, 216, ty)];
        for (let x = 0; x < size; x++) {
            let cov = 0;
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
                if (inPoly((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, poly)) cov++;
            cov /= S * S;
            const o = y * stride + 1 + x * 3;
            for (let k = 0; k < 3; k++) raw[o + k] = Math.round(bg[k] * (1 - cov) + bl[k] * cov);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
}
const ICONS = { 180: makeIcon(180), 192: makeIcon(192), 512: makeIcon(512) };

/* ---------- ملفات الـ PWA ---------- */
const MANIFEST = {
    name: "فلاش | تجربة الإشعارات", short_name: "فلاش",
    start_url: "/", scope: "/", display: "standalone",
    background_color: "#0a1628", theme_color: "#0a1628", lang: "ar", dir: "rtl",
    icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
};

const SW = String.raw`
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "فلاش", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    lang: "ar", dir: "rtl",
    data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ("focus" in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
`;

/* ---------- الصفحة ---------- */
const PAGE = String.raw`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>فلاش | تجربة الإشعارات</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="فلاش">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#0a1628">
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg1:#0a1628; --bg2:#0d1f3c; --panel:rgba(255,255,255,0.04); --border:rgba(59,130,246,0.25);
  --blue:#3b82f6; --blue-soft:#60a5fa; --blue-deep:#1d4ed8;
  --green:#22c55e; --red:#ef4444; --amber:#eab308; --text:#e2e8f0; --muted:#64748b;
}
*{box-sizing:border-box;margin:0;padding:0;font-family:'Tajawal','Tahoma','Segoe UI',sans-serif;-webkit-tap-highlight-color:transparent}
html,body{min-height:100%}
body{background:linear-gradient(160deg,var(--bg1),var(--bg2)) fixed;color:var(--text);
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
header svg{width:38px;height:38px;flex:none}
header h1{font-size:26px;font-weight:800;line-height:1.1}
header p{font-size:13px;color:var(--muted);margin-top:3px}
#conn{margin-inline-start:auto;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}
#conn i{width:8px;height:8px;border-radius:50%;background:var(--muted);display:inline-block}
#conn.ok i{background:var(--green)}
h2{font-size:16px;font-weight:700;margin:26px 0 10px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{font-size:12px;font-weight:500;padding:3px 10px;border-radius:99px;background:rgba(59,130,246,0.15);color:var(--blue-soft)}
.chip.on{background:rgba(34,197,94,0.15);color:#4ade80}
.chip.off{background:rgba(100,116,139,0.18);color:var(--muted)}
.chip.warn{background:rgba(234,179,8,0.15);color:var(--amber)}
.me-name{font-weight:700;font-size:17px}
.btn{width:100%;border:none;border-radius:12px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;color:#fff;
  background:linear-gradient(135deg,var(--blue),var(--blue-deep));margin-top:14px}
.btn.sec{background:transparent;border:1px solid var(--border);color:var(--blue-soft)}
.btn.sm{width:auto;margin:0;padding:8px 16px;font-size:13px;border-radius:10px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn:focus-visible,input:focus-visible{outline:2px solid var(--blue-soft);outline-offset:2px}
.row2{display:flex;gap:8px}
.row2 .btn{margin-top:10px}
.hint{font-size:13px;color:var(--muted);margin-top:10px;line-height:1.7}
.guide{border-color:rgba(234,179,8,0.45);background:rgba(234,179,8,0.06)}
.guide b{color:var(--amber)}
.guide ol{padding-inline-start:20px;margin-top:8px;line-height:2;font-size:14px}
input{width:100%;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:10px;color:var(--text);
  padding:11px 12px;font-size:14px;margin-bottom:8px}
input::placeholder{color:var(--muted)}
.dev-head{display:flex;align-items:center;justify-content:space-between;margin:26px 0 10px}
.dev-head h2{margin:0}
.dev-head span{font-size:13px;color:var(--muted)}
.dev-list{background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.dev{display:flex;align-items:center;gap:12px;padding:14px 16px}
.dev + .dev{border-top:1px solid var(--border)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex:none}
.dot.on{background:var(--green);box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:pulse 2s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.dev-main{flex:1;min-width:0}
.dev-name{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.dev-name small{font-size:11px;font-weight:500;color:var(--blue-soft);background:rgba(59,130,246,.15);padding:1px 8px;border-radius:99px}
.empty{padding:22px;text-align:center;color:var(--muted);font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translate(-50%,20px);opacity:0;
  background:#10264a;border:1px solid var(--border);color:var(--text);padding:11px 18px;border-radius:12px;font-size:14px;
  transition:.25s;pointer-events:none;max-width:90%;text-align:center;z-index:50}
#toast.show{opacity:1;transform:translate(-50%,0)}

/* شاشة الدخول */
#splash{position:fixed;inset:0;z-index:100;background:radial-gradient(circle at 50% 42%,#12305e 0%,var(--bg1) 62%);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;transition:opacity .45s}
#splash.out{opacity:0;pointer-events:none}
#splash svg{width:120px;height:120px;filter:drop-shadow(0 0 22px rgba(59,130,246,.55))}
#splash path{fill:url(#bg);fill-opacity:0;stroke:var(--blue-soft);stroke-width:1.6;stroke-linejoin:round;
  stroke-dasharray:1;stroke-dashoffset:1;animation:draw .7s ease-out forwards,fill .4s .6s ease-out forwards}
#splash .sname{font-size:34px;font-weight:800;letter-spacing:.5px;opacity:0;animation:fade .4s .75s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fill{to{fill-opacity:1;stroke-opacity:0}}
@keyframes fade{to{opacity:1}}
@media (prefers-reduced-motion:reduce){
  #splash path{animation:none;stroke-dashoffset:0;fill-opacity:1}
  #splash .sname{animation:none;opacity:1}
  .dot.on{animation:none}
  #splash,#toast{transition:none}
}
</style>
</head>
<body>

<div id="splash">
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>
    <path pathLength="1" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/>
  </svg>
  <div class="sname">فلاش</div>
</div>

<main>
  <header>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>
      <path fill="url(#hg)" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/>
    </svg>
    <div><h1>فلاش</h1><p>تجربة الإشعارات خارج الموقع</p></div>
    <div id="conn"><i></i><span>يتصل...</span></div>
  </header>

  <div id="guide" class="panel guide" hidden>
    <b>على الآيفون لازم تثبّت الموقع كتطبيق أول</b>
    <ol>
      <li>افتح الموقع من سفاري</li>
      <li>اضغط زر المشاركة</li>
      <li>اختر «إضافة إلى الشاشة الرئيسية»</li>
      <li>خلّ «فتح كتطبيق ويب» شغّال ثم «إضافة»</li>
      <li>افتح الموقع من الأيقونة الجديدة وفعّل الإشعارات</li>
    </ol>
  </div>

  <h2>جهازك</h2>
  <div class="panel">
    <div class="me-name" id="meName">...</div>
    <div class="chips" id="meChips"></div>
    <div id="meAction"></div>
    <div class="hint" id="meHint"></div>
  </div>

  <h2>نص الإشعار</h2>
  <input id="title" value="فلاش" maxlength="60" placeholder="العنوان">
  <input id="body" value="رد عليك الإداري على تكتك ⚡" maxlength="160" placeholder="النص">

  <div class="dev-head"><h2>الأجهزة</h2><span id="count"></span></div>
  <div class="dev-list" id="list"><div class="empty">...</div></div>
  <button class="btn" id="sendAll" disabled>إرسال للجميع</button>
</main>

<div id="toast"></div>

<script>
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var id = store.get("fl_id");
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(16) + Math.random().toString(16).slice(2));
    id = id.replace(/[^a-zA-Z0-9-]/g, "");
    store.set("fl_id", id);
  }

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var supportsPush = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);

  function guessName() {
    var t = "جهاز";
    if (/iPhone/.test(ua)) t = "آيفون";
    else if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) t = "آيباد";
    else if (/Android/.test(ua)) t = "أندرويد";
    else if (/Windows/.test(ua)) t = "ويندوز";
    else if (/Mac/.test(ua)) t = "ماك";
    else if (/Linux/.test(ua)) t = "لينكس";
    return t + " #" + id.slice(0, 4);
  }
  var myName = guessName();

  var reg = null, mySub = null, vapidKey = null, devices = [], ready = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function chip(text, cls) { return el("span", "chip " + (cls || ""), text); }
  var toastT;
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }
  function post(url, data) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function urlB64(s) {
    var p = "=".repeat((4 - s.length % 4) % 4);
    var b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
    var a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }

  /* ---------- جهازك ---------- */
  function renderMe() {
    $("#meName").textContent = myName;
    var chips = $("#meChips"); chips.textContent = "";
    chips.appendChild(chip(standalone ? "تطبيق ويب" : "متصفح", standalone ? "on" : ""));
    var act = $("#meAction"); act.textContent = "";
    var hint = $("#meHint"); hint.textContent = "";
    $("#guide").hidden = !(isIOS && !standalone);

    if (!supportsPush) {
      chips.appendChild(chip("الإشعارات غير مدعومة", "warn"));
      hint.textContent = (isIOS && !standalone)
        ? "ثبّت الموقع على الشاشة الرئيسية وافتحه من الأيقونة عشان تظهر لك الإشعارات."
        : "هذا المتصفح ما يدعم إشعارات الويب.";
      return;
    }
    if (Notification.permission === "denied") {
      chips.appendChild(chip("الإشعارات محظورة", "warn"));
      hint.textContent = "فعّلها من إعدادات الجهاز للموقع ثم ارجع.";
      return;
    }
    if (mySub) {
      chips.appendChild(chip("الإشعارات مفعّلة", "on"));
      var row = el("div", "row2");
      var t = el("button", "btn", "إشعار تجريبي لي");
      t.onclick = function () { send(id); };
      var o = el("button", "btn sec", "إيقاف");
      o.onclick = disable;
      row.appendChild(t); row.appendChild(o); act.appendChild(row);
      hint.textContent = "تقدر تقفل التطبيق وتجيك الإشعارات.";
    } else {
      chips.appendChild(chip("الإشعارات مطفية", "off"));
      var b = el("button", "btn", "فعّل الإشعارات");
      b.disabled = !ready;
      b.onclick = enable;
      act.appendChild(b);
    }
  }

  function enable() {
    if (!ready) return;
    Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") { renderMe(); toast("ما انعطى إذن الإشعارات"); return; }
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(vapidKey) }).then(function (sub) {
        mySub = sub; store.set("fl_vapid", vapidKey);
        return post("/api/subscribe", { id: id, sub: sub.toJSON() });
      }).then(function () { renderMe(); toast("تم تفعيل الإشعارات ✓"); });
    }).catch(function (e) { toast("فشل التفعيل: " + (e && e.message ? e.message : e)); });
  }
  function disable() {
    var p = mySub ? mySub.unsubscribe() : Promise.resolve();
    p.then(function () { mySub = null; return post("/api/unsubscribe", { id: id }); }).then(renderMe);
  }

  /* ---------- قائمة الأجهزة ---------- */
  function renderDevices() {
    var list = $("#list"); list.textContent = "";
    var online = devices.filter(function (d) { return d.online; }).length;
    $("#count").textContent = online + " متصل الآن من " + devices.length;
    var canAll = devices.some(function (d) { return d.push; });
    $("#sendAll").disabled = !canAll;
    if (!devices.length) { list.appendChild(el("div", "empty", "ما فيه أجهزة بعد")); return; }
    devices.forEach(function (d) {
      var row = el("div", "dev");
      row.appendChild(el("span", "dot" + (d.online ? " on" : "")));
      var main = el("div", "dev-main");
      var nm = el("div", "dev-name", d.name);
      if (d.id === id) nm.appendChild(el("small", "", "جهازك"));
      main.appendChild(nm);
      var chips = el("div", "chips");
      chips.appendChild(chip(d.online ? "متصل" : "غير متصل", d.online ? "on" : "off"));
      chips.appendChild(chip(d.standalone ? "تطبيق ويب" : "متصفح"));
      chips.appendChild(chip(d.push ? "إشعارات مفعّلة" : "بدون إشعارات", d.push ? "on" : "off"));
      main.appendChild(chips);
      row.appendChild(main);
      var b = el("button", "btn sm", "إرسال");
      b.disabled = !d.push;
      b.onclick = function () { send(d.id); };
      row.appendChild(b);
      list.appendChild(row);
    });
  }

  function send(target) {
    var title = $("#title").value.trim() || "فلاش";
    var body = $("#body").value.trim();
    var data = { title: title, body: body };
    if (target === "all") data.all = true; else data.id = target;
    post("/api/send", data).then(function (r) {
      if (r.error) return toast(r.error);
      if (r.sent) toast("انرسل إلى " + r.sent + " جهاز ✓");
      else toast("ما انرسل لأي جهاز");
      if (r.failed && r.failed.length) toast("فشل الإرسال لـ " + r.failed.map(function (f) { return f.name; }).join("، "));
    }).catch(function () { toast("تعذر الاتصال بالسيرفر"); });
  }
  $("#sendAll").onclick = function () { send("all"); };

  /* ---------- الاتصال المباشر ---------- */
  function connect() {
    var es = new EventSource("/api/stream?id=" + id + "&name=" + encodeURIComponent(myName) + "&sa=" + (standalone ? 1 : 0));
    var c = $("#conn");
    es.onopen = function () { c.className = "ok"; c.lastChild.textContent = "متصل"; };
    es.onerror = function () { c.className = ""; c.lastChild.textContent = "يعيد الاتصال..."; };
    es.addEventListener("devices", function (e) { devices = JSON.parse(e.data); renderDevices(); });
  }

  /* ---------- البداية ---------- */
  renderMe(); connect();

  if (supportsPush) {
    navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; })
      .then(function (r) { reg = r; return fetch("/api/vapid").then(function (x) { return x.json(); }); })
      .then(function (j) {
        vapidKey = j.key;
        return reg.pushManager.getSubscription();
      }).then(function (sub) {
        if (sub && store.get("fl_vapid") && store.get("fl_vapid") !== vapidKey) {
          return sub.unsubscribe().then(function () { return null; });
        }
        return sub;
      }).then(function (sub) {
        mySub = sub; ready = true;
        if (sub) post("/api/subscribe", { id: id, sub: sub.toJSON() });
        renderMe();
      }).catch(function (e) { toast("تعذر تجهيز الإشعارات"); });
  }

  /* شاشة الدخول */
  setTimeout(function () {
    var s = $("#splash"); s.classList.add("out");
    setTimeout(function () { s.remove(); }, 500);
  }, 1500);
})();
</script>
</body>
</html>`;

/* ---------- السيرفر ---------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

app.get("/", (req, res) => { res.set("Cache-Control", "no-cache"); res.type("html").send(PAGE); });
app.get("/manifest.json", (req, res) => res.type("application/manifest+json").send(JSON.stringify(MANIFEST)));
app.get("/sw.js", (req, res) => { res.set({ "Content-Type": "application/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" }); res.send(SW); });
for (const n of [180, 192, 512]) app.get("/icon-" + n + ".png", (req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.type("png").send(ICONS[n]); });
app.get("/api/vapid", (req, res) => res.json({ key: vapid.publicKey }));

app.get("/api/stream", (req, res) => {
    const id = String(req.query.id || "");
    if (!validId(id)) return res.status(400).end();
    upsert(id, req.query.name, req.query.sa === "1");
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    if (!conns.has(id)) conns.set(id, new Set());
    conns.get(id).add(res);
    pendingOff.delete(id);
    streams.add(res);
    broadcast();

    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
    req.on("close", () => {
        clearInterval(hb);
        streams.delete(res);
        const set = conns.get(id);
        if (set) set.delete(res);
        if (!set || set.size === 0) {
            pendingOff.add(id);
            setTimeout(() => {
                if (conns.get(id) && conns.get(id).size > 0) return;
                pendingOff.delete(id);
                const d = devices.get(id); if (d) { d.lastSeen = Date.now(); saveSoon(); }
                broadcast();
            }, 4000);
        }
    });
});

app.post("/api/subscribe", (req, res) => {
    const { id, sub } = req.body || {};
    if (!validId(id) || !sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
        return res.status(400).json({ error: "بيانات غير صالحة" });
    const d = devices.get(id) || upsert(id, "جهاز", false);
    d.sub = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    saveSoon(); broadcast();
    res.json({ ok: true });
});

app.post("/api/unsubscribe", (req, res) => {
    const d = devices.get((req.body || {}).id);
    if (d) { d.sub = null; saveSoon(); broadcast(); }
    res.json({ ok: true });
});

const hits = new Map();
function limited(ip) {
    const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
    a.push(now); hits.set(ip, a);
    return a.length > 40;
}

app.post("/api/send", async (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ error: "بطّئ شوي، كثرت الطلبات" });
    const b = req.body || {};
    const payload = JSON.stringify({
        title: String(b.title || "فلاش").slice(0, 60),
        body: String(b.body || "").slice(0, 160),
        url: "/",
    });
    const targets = b.all ? [...devices.values()].filter(d => d.sub) : [devices.get(b.id)].filter(d => d && d.sub);
    if (!targets.length) return res.status(404).json({ error: "هذا الجهاز ما فعّل الإشعارات" });

    const failed = []; let sent = 0;
    await Promise.all(targets.map(async d => {
        try {
            await webpush.sendNotification(d.sub, payload, { TTL: 120, urgency: "high" });
            sent++;
        } catch (e) {
            failed.push({ id: d.id, name: d.name, code: e.statusCode || 0 });
            if (e.statusCode === 404 || e.statusCode === 410) { d.sub = null; saveSoon(); }
            else console.log("❌ push:", d.name, e.statusCode || "", e.body || e.message);
        }
    }));
    if (failed.length) broadcast();
    res.json({ sent, failed });
});

app.listen(PORT, () => console.log("⚡ فلاش | تجربة الإشعارات شغالة على المنفذ " + PORT));
