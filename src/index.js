import cluster from "node:cluster";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

import { config } from "./config.js";
import { Counter, RateLimiter, clientIp } from "./limits.js";
import { handleConnect, handleForward, tunnels } from "./netproxy.js";
import { mount, serve } from "./static.js";
import { patchLibs } from "./patch.js";

patchLibs();

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// ---------------- Cluster ----------------
if (cluster.isPrimary && config.workers > 1) {
	console.log(`[master] starting ${config.workers} workers on port ${config.port}`);
	for (let i = 0; i < config.workers; i++) cluster.fork();
	cluster.on("exit", (w, code) => {
		console.log(`[master] worker ${w.process.pid} exited (${code}); restarting`);
		setTimeout(() => cluster.fork(), 1000);
	});
	for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));
} else {
	startWorker();
}

function startWorker() {
	// ---------------- Wisp ----------------
	logging.set_level(config.logLevel === "debug" ? logging.DEBUG : logging.NONE);
	Object.assign(wisp.options, {
		allow_udp_streams: false,
		allow_private_ips: process.env.ALLOW_PRIVATE === "1",
		allow_loopback_ips: process.env.ALLOW_PRIVATE === "1",
		dns_servers: config.dnsServers,
		dns_result_order: config.ipv4Only ? "ipv4first" : "verbatim",
		port_blacklist: [...config.blockedPorts],
		stream_limit_total: 200, // لكل اتصال Wisp
		parse_real_ip: false,
	});

	const wsPerIp = new Counter();
	const limiter = new RateLimiter(config.reqPerSecPerIp, config.reqBurstPerIp);
	const mounts = [
		mount("/scram/", scramjetPath),
		mount("/libcurl/", libcurlPath),
		mount("/baremux/", baremuxPath),
		mount("/", publicPath),
	];
	const started = Date.now();
	let reqCount = 0;

	const server = http.createServer((req, res) => {
		reqCount++;
		const ip = clientIp(req);

		// طلب بروكسي شبكة (المتصفح/الواي فاي بيبعت URL كامل)
		if (/^https?:\/\//i.test(req.url)) {
			if (!limiter.take(ip)) {
				res.writeHead(429, { "Retry-After": "2" });
				return res.end("Too many requests");
			}
			return handleForward(req, res);
		}

		if (!limiter.take(ip)) {
			res.writeHead(429, { "Retry-After": "2" });
			return res.end("Too many requests");
		}

		// مطلوبة لـ SharedArrayBuffer في Scramjet
		if (process.env.ISOLATION === "1") {
			res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
			res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
		}
		res.setHeader("X-Content-Type-Options", "nosniff");

		if (req.url === "/healthz") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			return res.end("ok");
		}
		if (req.url === "/stats") {
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify({
				pid: process.pid,
				uptimeSec: Math.round((Date.now() - started) / 1000),
				requests: reqCount,
				wispSockets: wsPerIp.total,
				tunnels: tunnels.total,
				rssMB: Math.round(process.memoryUsage().rss / 1048576),
			}));
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			return res.end();
		}
		if (serve(mounts, req, res)) return;
		if (config.logLevel === "debug") console.log("[404]", req.method, req.url);
		req.url = "/404.html";
		if (!serve(mounts, req, res, 404)) {
			res.writeHead(404);
			res.end("Not found");
		}
	});

	if (config.logLevel === "debug") server.on("upgrade", (r) => console.log("[upgrade]", r.url));
	server.on("connect", handleConnect);

	server.on("upgrade", (req, socket, head) => {
		const ip = clientIp(req);
		socket.on("error", () => {});
		if (!req.url.endsWith("/wisp/")) return socket.destroy();
		if (wsPerIp.get(ip) >= config.wispStreamsPerIp / 10 || wsPerIp.total >= config.wispStreamsTotal / 10) {
			socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
			return socket.destroy();
		}
		wsPerIp.inc(ip);
		socket.once("close", () => wsPerIp.dec(ip));
		socket.setNoDelay(true);
		wisp.routeRequest(req, socket, head);
	});

	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 20_000;
	server.requestTimeout = 0; // الطلبات الطويلة (فيديو) مسموحة
	server.maxConnections = 8000;

	server.listen({ port: config.port, host: config.host, exclusive: false }, () => {
		if (cluster.isPrimary || cluster.worker?.id === 1) {
			console.log(`Listening on http://${config.host}:${config.port}  (workers: ${config.workers})`);
			const pub = process.env.SERVER_IP && process.env.SERVER_IP !== "0.0.0.0" ? process.env.SERVER_IP : "<IP>";
			console.log(`Web UI:       http://${pub}:${config.port}/`);
			console.log(`Network proxy: set <IP>:${config.port} as HTTP proxy ${config.proxyUser ? "(auth on)" : "(no auth)"}`);
		}
	});

	// ---- تسجيل أسباب الإيقاف عشان نعرف الفصل جاي منين ----
	const stamp = () => new Date().toISOString();
	const mem = () => Math.round(process.memoryUsage().rss / 1048576) + "MB";
	process.on("uncaughtException", (e) => console.error(`[${stamp()}] [uncaught]`, e?.stack || e));
	process.on("unhandledRejection", (e) => console.error(`[${stamp()}] [unhandled]`, e?.stack || e));
	for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(s, () => {
			console.log(`[${stamp()}] [stop] received ${s} from the host/panel (not a crash). uptime=${Math.round(process.uptime())}s rss=${mem()}`);
			process.exit(0);
		});
	}
	process.on("exit", (code) => console.log(`[${stamp()}] [exit] code=${code} uptime=${Math.round(process.uptime())}s rss=${mem()}`));
	// نبضة كل 10 دقايق: لو السيرفر اتوقف بعدها تعرف آخر وقت كان شغال فيه
	if (cluster.isPrimary || cluster.worker?.id === 1) {
		setInterval(() => console.log(`[${stamp()}] [alive] uptime=${Math.round(process.uptime())}s rss=${mem()} wisp=${wsPerIp.total} tunnels=${tunnels.total}`), 600_000).unref();
	}
}
