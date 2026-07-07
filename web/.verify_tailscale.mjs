import { launch } from "puppeteer-core";
const B = "https://main-pc.tail3ba909.ts.net:8443";

const browser = await launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--ignore-certificate-errors"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(B + "/code", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  const hasHideBtn = await page.$('button[title="hide sidebar"]');
  console.log("hide-sidebar button present on real tailscale URL:", !!hasHideBtn);
  if (hasHideBtn) {
    await hasHideBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    const railGone = await page.evaluate(() => !document.querySelector('nav.hidden.md\\:flex'));
    const showBtn = await page.$('button[title="show sidebar"]');
    console.log("collapsed via tailscale URL:", railGone, "re-expand button present:", !!showBtn);
  }
  // mobile check through the real URL too
  const page2 = await browser.newPage();
  await page2.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" });
  await page2.goto(B + "/code", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  const mobileOverflow = await page2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log("mobile /code via tailscale, horizontal overflow:", mobileOverflow);
} finally {
  await browser.close();
}
