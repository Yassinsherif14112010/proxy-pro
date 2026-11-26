import dns from "node:dns";
import net from "node:net";
import { config } from "./config.js";

const resolver = new dns.Resolver();
try {
	resolver.setServers(config.dnsServers);
} catch {}

// كاش DNS صغير لتقليل زمن الاتصال تحت الضغط
const cache = new Map();
const TTL = 60_000;

function isPrivateV4(ip) {
	const p = ip.split(".").map(Number);
	if (p.length !== 4) return true;
	const [a, b] = p;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}
function isPrivateV6(ip) {
	const l = ip.toLowerCase();
	if (l === "::1" || l === "::") return true;
	if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
	const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (m) return isPrivateV4(m[1]);
	return false;
}
export function isPrivateIp(ip) {
	if (process.env.ALLOW_PRIVATE === "1") return false; // للاختبار المحلي فقط
	const v = net.isIP(ip);
	if (v === 4) return isPrivateV4(ip);
	if (v === 6) return isPrivateV6(ip);
	return true;
}

/**
 * يحوّل الاسم لـ IP عام فقط (يمنع الوصول للشبكة الداخلية / SSRF).
 */
export async function resolvePublic(host) {
	if (net.isIP(host)) {
		if (isPrivateIp(host)) throw new Error("blocked: private address");
		return host;
	}
	const hit = cache.get(host);
	if (hit && hit.exp > Date.now()) return hit.ip;

	let addrs = [];
	try {
		addrs = await resolver.resolve4(host);
	} catch {
		// fallback للـ resolver بتاع النظام
		const r = await dns.promises.lookup(host, { family: config.ipv4Only ? 4 : 0, all: true });
		addrs = r.map((x) => x.address);
	}
	const ok = addrs.filter((a) => !isPrivateIp(a));
	if (!ok.length) throw new Error("blocked: private address");
	const ip = ok[Math.floor(Math.random() * ok.length)];
	cache.set(host, { ip, exp: Date.now() + TTL });
	if (cache.size > 5000) cache.delete(cache.keys().next().value);
	return ip;
}
