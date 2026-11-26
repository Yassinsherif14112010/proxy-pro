// عدّاد اتصالات + Token bucket لكل IP
export class Counter {
	constructor() {
		this.map = new Map();
		this.total = 0;
	}
	get(ip) {
		return this.map.get(ip) || 0;
	}
	inc(ip) {
		this.map.set(ip, this.get(ip) + 1);
		this.total++;
	}
	dec(ip) {
		const n = this.get(ip) - 1;
		if (n <= 0) this.map.delete(ip);
		else this.map.set(ip, n);
		this.total = Math.max(0, this.total - 1);
	}
}

export class RateLimiter {
	constructor(perSec, burst) {
		this.perSec = perSec;
		this.burst = burst;
		this.buckets = new Map();
		setInterval(() => {
			const now = Date.now();
			for (const [k, b] of this.buckets) if (now - b.t > 60_000) this.buckets.delete(k);
		}, 30_000).unref();
	}
	take(ip) {
		const now = Date.now();
		let b = this.buckets.get(ip);
		if (!b) b = { tokens: this.burst, t: now };
		b.tokens = Math.min(this.burst, b.tokens + ((now - b.t) / 1000) * this.perSec);
		b.t = now;
		this.buckets.set(ip, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}
}

export function clientIp(req) {
	let ip = req.socket.remoteAddress || "unknown";
	if (ip.startsWith("::ffff:")) ip = ip.slice(7);
	return ip;
}
