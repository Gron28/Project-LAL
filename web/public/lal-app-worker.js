/* Online-only app shell: never cache models, API responses, or private lab data. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAL unavailable</title><body style="margin:0;background:#111311;color:#EDECE7;font:16px system-ui;padding:12vh 8vw">
<h1>Connect to your lab</h1><p>The local server could not be reached. Check that your computer is awake, LAL is running, and Tailscale is connected.</p>
<p>No offline changes have been saved.</p><button onclick="location.reload()" style="padding:12px 20px;border:0;border-radius:8px;background:#E2CF00;font:inherit">Try again</button></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })));
});
