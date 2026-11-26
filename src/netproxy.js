import net from "node:net";
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { resolvePublic } from "./netguard.js";
import { Counter, clientIp } from "./limits.js";

export const tunnels = new Counter();

const HOP = new Set([
	"connection", "proxy-connection", "keep-alive", "proxy-authenticate",
	"proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

export function checkAuth(req) {
	if (!config.proxyUser) return true;
	const h = req.headers["proxy-authorization"] || "";
	const m = h.match(/^Basic (.+)$/i);
	if (!m) return false;
	const [u, ...p] = Buffer.from(m[1], "base64").toString().split(":");
	return u === config.proxyUser && p.join(":") === config.proxyPass;
}

/** CONNECT host:port  -> نفق TCP (HTTPS وغيره) */
export function handleConnect(req, clientSocket, head) {
	const ip = clientIp(req);
	clientSocket.on("error", () => {});
	if (!checkAuth(req)) {
		clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\nContent-Length: 0\r\n\r\n');
		return;
	}
	const m = req.url.match(/^\[?([^\]]+?)\]?:(\d+)$/);
	if (!m) return clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	const host = m[1];
	const port = +m[2];
	if (config.blockedPorts.has(port)) return clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	if (tunnels.get(ip) >= config.maxTunnelsPerIp || tunnels.total >= config.maxTunnelsTotal) {
		return clientSocket.end("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\n\r\n");
	}
	tunnels.inc(ip);
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			tunnels.dec(ip);
		}
	};

	resolvePublic(host)
		.then((target) => {
			const upstream = net.connect({ host: target, port, timeout: config.connectTimeoutMs });
			upstream.setNoDelay(true);
			clientSocket.setNoDelay(true);
			upstream.once("connect", () => {
				upstream.setTimeout(config.idleTimeoutMs);
				clientSocket.setTimeout(config.idleTimeoutMs);
				clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head?.length) upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			const kill = () => {
				upstream.destroy();
				clientSocket.destroy();
				release();
			};
			upstream.on("timeout", kill);
			clientSocket.on("timeout", kill);
			upstream.on("error", () => {
				if (!upstream.connecting && upstream.bytesRead === 0 && !clientSocket.destroyed && !clientSocket.writableEnded && !upstream.__ok) {
					try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
				}
				kill();
			});
			upstream.on("connect", () => (upstream.__ok = true));
			upstream.on("close", kill);
			clientSocket.on("close", kill);
		})
		.catch(() => {
			try { clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch {}
			release();
		});
}

/** طلب HTTP عادي بصيغة absolute-URI (GET http://site/...) */
export function handleForward(req, res) {
	if (!checkAuth(req)) {
		res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="proxy"', "Content-Length": 0 });
		return res.end();
	}
	let u;
	try {
		u = new URL(req.url);
	} catch {
		res.writeHead(400);
		return res.end("Bad URL");
	}
	const port = +(u.port || (u.protocol === "https:" ? 443 : 80));
	if (!/^https?:$/.test(u.protocol) || config.blockedPorts.has(port)) {
		res.writeHead(403);
		return res.end("Forbidden");
	}
	resolvePublic(u.hostname)
		.then((target) => {
			const headers = {};
			for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
			headers.host = u.host;
			const mod = u.protocol === "https:" ? https : http;
			const up = mod.request(
				{
					host: target, port, method: req.method, path: u.pathname + u.search, headers,
					servername: u.hostname, timeout: config.connectTimeoutMs,
				},
				(r) => {
					const h = {};
					for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
					res.writeHead(r.statusCode, h);
					r.pipe(res);
				}
			);
			up.on("timeout", () => up.destroy(new Error("timeout")));
			up.on("error", () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			res.on("close", () => up.destroy());
			req.pipe(up);
		})
		.catch(() => {
			res.writeHead(403);
			res.end("Forbidden");
		});
}
