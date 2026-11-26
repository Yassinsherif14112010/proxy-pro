// إصلاحات على مكتبات node_modules بتتطبق تلقائياً عند التشغيل (آمنة لو اتشغلت أكتر من مرة):
// 1) libcurl-transport كان بيفتح الجلسة قبل ما WebAssembly يخلص تحميل ("wasm not loaded yet").
// 2) bare-mux بيستنى رد الـ SharedWorker 1.5 ثانية بس، وده قليل على الأجهزة البطيئة
//    ("Unable to get bare-mux workerPath from localStorage"). بنوسّعها لـ 12 ثانية.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const MARK_WASM = "/*proxy-pro:wait-wasm*/";
const WASM_OLD = `    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({`;
const WASM_NEW = `    libcurl.set_websocket(this.wisp);
    ${MARK_WASM}
    if (!libcurl.ready) {
      await new Promise((resolve) => {
        if (libcurl.ready) return resolve();
        const prev = libcurl.onload;
        libcurl.onload = () => { try { prev && prev(); } catch (e) {} resolve(); };
      });
    }
    this.session = new libcurl.HTTPSession({`;

const PING_OLD = `"pong"===t.data.type&&e()},setTimeout(r,1500)`;
const PING_NEW = `"pong"===t.data.type&&e()},setTimeout(r,12000)`;

function edit(file, oldStr, newStr, label) {
	try {
		const src = fs.readFileSync(file, "utf8");
		if (!src.includes(oldStr)) return false; // اتطبق قبل كده أو النسخة مختلفة
		fs.writeFileSync(file, src.split(oldStr).join(newStr));
		console.log(`[patch] ${label}: ${path.basename(file)}`);
		return true;
	} catch (e) {
		console.warn(`[patch] ${label} skipped (${path.basename(file)}):`, e.message);
		return false;
	}
}

export function patchLibs() {
	try {
		const curl = require("@mercuryworkshop/libcurl-transport").libcurlPath;
		edit(path.join(curl, "index.mjs"), WASM_OLD, WASM_NEW, "libcurl wait-wasm");
	} catch (e) {
		console.warn("[patch] libcurl skipped:", e.message);
	}
	try {
		const bm = require("@mercuryworkshop/bare-mux/node").baremuxPath;
		for (const f of ["index.js", "index.mjs"]) edit(path.join(bm, f), PING_OLD, PING_NEW, "bare-mux ping timeout");
	} catch (e) {
		console.warn("[patch] bare-mux skipped:", e.message);
	}
	try {
		const sj = require("@mercuryworkshop/scramjet/path").scramjetPath;
		for (const f of ["scramjet.all.js", "scramjet.bundle.js"]) edit(path.join(sj, f), PING_OLD, PING_NEW, "scramjet ping timeout");
	} catch (e) {
		console.warn("[patch] scramjet skipped:", e.message);
	}
}
