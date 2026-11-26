"use strict";
const $ = (id) => document.getElementById(id);
const store = {
	get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
	set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let scramjet = null;
let connection = null;
let booting = null;
// لازم init() تخلص (بتجهّز قاعدة البيانات) قبل ما الـ Service Worker يشتغل
function boot() {
	if (booting) return booting;
	booting = (async () => {
		const { ScramjetController } = $scramjetLoadController();
		scramjet = new ScramjetController({
			files: { wasm: "/scram/scramjet.wasm.wasm", all: "/scram/scramjet.all.js", sync: "/scram/scramjet.sync.js" },
		});
		await scramjet.init();
		connection = new BareMux.BareMuxConnection("/baremux/worker.js");
	})();
	booting.catch(() => { booting = null; });
	return booting;
}
// نبدأ التجهيز أول ما الصفحة تفتح (قبل أي ضغطة)
boot().catch(() => {});

function withTimeout(p, ms, label) {
	return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("انتهت المهلة في خطوة: " + label)), ms))]);
}

// تشخيص بيئة المتصفح (بيظهر في أسفل الصفحة)
function envInfo() {
	const secure = window.isSecureContext;
	const sw = !!navigator.serviceWorker;
	const shared = typeof SharedWorker !== "undefined";
	return { secure, sw, shared };
}

// ---------- helpers ----------
function toUrl(input) {
	input = input.trim();
	if (!input) return null;
	try { const u = new URL(input); if (/^https?:$/.test(u.protocol)) return u.toString(); } catch {}
	if (!/\s/.test(input) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(input)) return "https://" + input;
	const eng = document.querySelector('input[name="eng"]:checked').value;
	return eng.replace("%s", encodeURIComponent(input));
}
function showMsg(text, cls) {
	const m = $("msg");
	m.className = "msg show " + cls;
	m.innerHTML = text;
	show("home");
}
function errorText(err) {
	const i = envInfo();
	const diag = `\n\n[تشخيص] بيئة آمنة: ${i.secure ? "نعم" : "لا"} | Service Worker: ${i.sw ? "نعم" : "لا"} | SharedWorker: ${i.shared ? "نعم" : "لا"}`;
	if (err && err.code === "NOT_SECURE")
		return `المتصفح بيمنع الـ Service Worker على <code>http://</code>.\nحلّين:\n١) في Chrome افتح <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code> وفعّلها واكتب <code>${location.origin}</code> ثم Relaunch.\n٢) أو استخدم وضع البروكسي: اكتب <code>${location.hostname}</code> والبورت <code>${location.port || 80}</code> في إعدادات البروكسي للواي فاي (من غير flags).${diag}`;
	return "تعذّر التشغيل: " + (err?.message || err) + diag;
}

// ---------- tabs ----------
const tabs = [];
let current = null;
let seq = 0;

function show(which) {
	$("homeview").classList.toggle("show", which === "home");
	for (const t of tabs) t.frame.frame.classList.toggle("show", which !== "home" && t === current);
}
function renderTabs() {
	const bar = $("tabbar");
	bar.querySelectorAll(".tab").forEach((n) => n.remove());
	for (const t of tabs) {
		const el = document.createElement("div");
		el.className = "tab" + (t === current ? " active" : "");
		el.innerHTML = `<span></span><button class="x" title="إغلاق">×</button>`;
		el.firstChild.textContent = t.title;
		el.onclick = () => select(t);
		el.querySelector(".x").onclick = (e) => { e.stopPropagation(); closeTab(t); };
		bar.insertBefore(el, $("newtab"));
	}
}
function select(t) {
	current = t;
	$("url").value = t.url || "";
	show(t.url ? "tab" : "home");
	renderTabs();
}
function closeTab(t) {
	const i = tabs.indexOf(t);
	t.frame.frame.remove();
	tabs.splice(i, 1);
	if (current === t) current = tabs[Math.max(0, i - 1)] || null;
	if (current) select(current); else { $("url").value = ""; show("home"); renderTabs(); }
}
async function ensureReady() {
	let last;
	for (let i = 0; i < 3; i++) {
		try { return await ensureReadyOnce(); } catch (e) { last = e; if (e && e.code === "NOT_SECURE") throw e; await new Promise((r) => setTimeout(r, 1500)); }
	}
	throw last;
}
async function ensureReadyOnce() {
	await withTimeout(boot(), 15000, "تجهيز المحرك");
	await withTimeout(registerSW(), 15000, "تسجيل Service Worker");
	const wisp = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
	if ((await withTimeout(connection.getTransport(), 15000, "قراءة وسيط النقل")) !== "/libcurl/index.mjs") {
		await withTimeout(connection.setTransport("/libcurl/index.mjs", [{ websocket: wisp }]), 20000, "ضبط وسيط النقل (Wisp)");
	}
}
async function go(input) {
	const url = toUrl(input);
	if (!url) return;
	try {
		$("msg").className = "msg";
		await ensureReady();
		if (!current || !current.frame) newTab(false);
	} catch (err) {
		showMsg(errorText(err), "err");
		return;
	}
	const t = current;
	t.url = url;
	t.title = new URL(url).hostname;
	$("url").value = url;
	t.frame.go(url);
	show("tab");
	renderTabs();
}
function newTab(goHome = true) {
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame-" + ++seq;
	$("viewport").appendChild(frame.frame);
	const t = { frame, url: "", title: "تبويب جديد" };
	frame.addEventListener("urlchange", (e) => {
		t.url = e.url.toString();
		try { t.title = new URL(t.url).hostname; } catch {}
		if (t === current) $("url").value = t.url;
		renderTabs();
	});
	tabs.push(t);
	current = t;
	if (goHome) { $("url").value = ""; show("home"); }
	renderTabs();
	return t;
}

// ---------- events ----------
$("form").addEventListener("submit", (e) => { e.preventDefault(); go($("q").value); $("q").value = ""; });
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") go($("url").value); });
$("newtab").onclick = () => { newTab(true); };
$("back").onclick = () => current?.frame.back();
$("fwd").onclick = () => current?.frame.forward();
$("reload").onclick = () => current?.frame.reload();
$("home").onclick = () => show("home");
$("full").onclick = () => { try { document.documentElement.requestFullscreen?.(); } catch {} };
document.querySelectorAll("[data-go]").forEach((a) =>
	a.addEventListener("click", (e) => { e.preventDefault(); go(a.href); })
);
document.querySelectorAll('input[name="eng"]').forEach((r) => {
	r.addEventListener("change", () => store.set("engine", r.value));
});
{
	const saved = store.get("engine", null);
	if (saved) { const r = [...document.querySelectorAll('input[name="eng"]')].find((x) => x.value === saved); if (r) r.checked = true; }
}

// ---------- status ----------
async function ping() {
	try {
		const r = await fetch("/stats", { cache: "no-store" });
		const s = await r.json();
		$("dot").className = "dot ok";
		$("status").textContent = `السيرفر شغال · ذاكرة ${s.rssMB}MB`;
	} catch {
		$("dot").className = "dot bad";
		$("status").textContent = "السيرفر لا يستجيب";
	}
}
{
	const i = envInfo();
	$("env").textContent = `آمنة: ${i.secure ? "✓" : "✗"} · SW: ${i.sw ? "✓" : "✗"} · SharedWorker: ${i.shared ? "✓" : "✗"}`;
}
ping(); setInterval(ping, 15000);

// أي خطأ غير متوقع يظهر على الشاشة بدل ما يفشل بصمت
window.addEventListener("unhandledrejection", (e) => showMsg("خطأ: " + (e.reason?.message || e.reason), "err"));
window.addEventListener("error", (e) => showMsg("خطأ: " + e.message, "err"));
