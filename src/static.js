import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
	".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
	".map": "application/json", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp",
};
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|txt|wasm|map)$/;

const cache = new Map(); // file -> {buf, br, gz, etag, mime, mtime}

export function mount(prefix, root) {
	return { prefix, root: path.resolve(root) };
}

function load(file) {
	const st = fs.statSync(file);
	const hit = cache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit;
	const buf = fs.readFileSync(file);
	const ext = path.extname(file).toLowerCase();
	const e = { buf, mtime: st.mtimeMs, mime: MIME[ext] || "application/octet-stream", etag: `"${st.size}-${st.mtimeMs.toString(36)}"` };
	if (COMPRESSIBLE.test(file) && buf.length > 1024) {
		e.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
		e.gz = zlib.gzipSync(buf, { level: 9 });
	}
	cache.set(file, e);
	return e;
}

export function serve(mounts, req, res, status = 200) {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
	} catch {
		return false;
	}
	if (pathname.endsWith("/")) pathname += "index.html";
	for (const m of mounts) {
		if (!pathname.startsWith(m.prefix)) continue;
		const rel = pathname.slice(m.prefix.length);
		const file = path.resolve(m.root, "." + path.sep + rel);
		if (!file.startsWith(m.root + path.sep)) continue;
		let e;
		try {
			if (!fs.statSync(file).isFile()) continue;
			e = load(file);
		} catch {
			continue;
		}
		const isSw = rel === "sw.js" || rel === "index.html" || rel.endsWith(".html");
		const headers = {
			"Content-Type": e.mime,
			ETag: e.etag,
			"Cache-Control": isSw ? "no-cache" : "public, max-age=86400",
			Vary: "Accept-Encoding",
		};
		if (req.headers["if-none-match"] === e.etag) {
			res.writeHead(304, headers);
			res.end();
			return true;
		}
		let body = e.buf;
		const ae = req.headers["accept-encoding"] || "";
		if (e.br && /\bbr\b/.test(ae)) { body = e.br; headers["Content-Encoding"] = "br"; }
		else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; headers["Content-Encoding"] = "gzip"; }
		headers["Content-Length"] = body.length;
		res.writeHead(status, headers);
		res.end(req.method === "HEAD" ? undefined : body);
		return true;
	}
	return false;
}
