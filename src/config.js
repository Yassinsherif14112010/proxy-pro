import os from "node:os";
import fs from "node:fs";

// تحميل ملف .env تلقائياً (للاستضافات اللي مفيهاش shell)
try {
	const envFile = new URL("../.env", import.meta.url);
	for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
		if (m && !line.trim().startsWith("#") && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
} catch {}

// Pterodactyl بيحط P_SERVER_UUID و SERVER_MEMORY (بالميجا) و SERVER_PORT
const isPtero = !!process.env.P_SERVER_UUID || !!process.env.SERVER_PORT;
const memMB = parseInt(process.env.SERVER_MEMORY || "0", 10) || 0;
const small = isPtero && memMB > 0 && memMB <= 1024;

const int = (v, d) => {
	const n = parseInt(v ?? "", 10);
	return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
	port: int(process.env.PORT ?? process.env.SERVER_PORT, 8080),
	host: process.env.HOST || "0.0.0.0",
	// عدد العمليات (cores). على الاستضافة المحدودة خليها 1 أو 2.
	workers: Math.max(1, int(process.env.WORKERS, isPtero ? (memMB >= 3000 ? 2 : 1) : Math.min(os.cpus().length, 2))),

	// ---- حماية الوصول (اختياري) ----
	// لو حطيت كلمة سر، بروكسي الشبكة (IP:Port) بيطلب user/pass.
	proxyUser: process.env.PROXY_USER || "",
	proxyPass: process.env.PROXY_PASS || "",

	// ---- حدود الأداء لكل مستخدم (حسب الـ IP) ----
	maxTunnelsPerIp: int(process.env.MAX_TUNNELS_PER_IP, 150), // اتصالات CONNECT المتزامنة
	maxTunnelsTotal: int(process.env.MAX_TUNNELS_TOTAL, small ? 600 : 3000), // لكل worker
	reqPerSecPerIp: int(process.env.REQ_PER_SEC_PER_IP, 60), // طلبات HTTP/ثانية (الواجهة + HTTP proxy)
	reqBurstPerIp: int(process.env.REQ_BURST_PER_IP, 200),
	wispStreamsPerIp: int(process.env.WISP_STREAMS_PER_IP, 300), // اتصالات Wisp المتزامنة لكل IP
	wispStreamsTotal: int(process.env.WISP_STREAMS_TOTAL, small ? 1000 : 4000),
	idleTimeoutMs: int(process.env.IDLE_TIMEOUT_MS, 120_000),
	connectTimeoutMs: int(process.env.CONNECT_TIMEOUT_MS, 15_000),

	// ---- DNS ----
	dnsServers: (process.env.DNS_SERVERS || "1.1.1.1,8.8.8.8").split(",").map((s) => s.trim()).filter(Boolean),
	ipv4Only: bool(process.env.IPV4_ONLY, true),

	// ---- أخرى ----
	blockedPorts: new Set([25, 465, 587, 2525]), // منع السبام
	logLevel: process.env.LOG_LEVEL || "info",
};
