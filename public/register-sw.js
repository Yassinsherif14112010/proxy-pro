"use strict";
async function registerSW() {
	if (!navigator.serviceWorker) {
		const insecure = location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname);
		const e = new Error(insecure ? "NOT_SECURE" : "NO_SW");
		e.code = insecure ? "NOT_SECURE" : "NO_SW";
		throw e;
	}
	await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	await navigator.serviceWorker.ready;
}
