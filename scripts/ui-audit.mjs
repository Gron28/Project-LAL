#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import puppeteer from "../web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const outputDir = path.resolve(process.argv[3] || "/tmp/lal-ui-audit");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const routes = ["/", "/chat", "/code", "/hive", "/train", "/models", "/library", "/benchmark", "/monitor", "/lens"];
const viewports = [
  { name: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
  { name: "phone", width: 390, height: 844, deviceScaleFactor: 1 },
];

fs.mkdirSync(outputDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];
try {
  for (const viewport of viewports) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    for (const route of routes) {
      consoleErrors.length = 0;
      // Dashboard and agent routes intentionally keep EventSource streams open,
      // so "network idle" is not a meaningful readiness signal in production.
      const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const slug = route === "/" ? "dashboard" : route.slice(1);
      const imagePath = path.join(outputDir, `${viewport.name}-${slug}.png`);
      await page.screenshot({ path: imagePath, fullPage: true });
      const facts = await page.evaluate(() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const unnamedButtonElements = [...document.querySelectorAll("button")].filter((button) => {
          if (!visible(button)) return false;
          return !(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent?.trim());
        });
        const unnamedInputElements = [...document.querySelectorAll("input, select, textarea")].filter((input) => {
          if (!visible(input)) return false;
          const id = input.getAttribute("id");
          return !(input.getAttribute("aria-label") || input.getAttribute("title") || (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || input.closest("label"));
        });
        const tinyTargets = [...document.querySelectorAll("a, button, input, select, textarea")].filter((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          return rect.width < 40 || rect.height < 40;
        }).length;
        return {
          title: document.title,
          h1: [...document.querySelectorAll("h1")].map((element) => element.textContent?.trim()).filter(Boolean),
          landmarks: {
            main: document.querySelectorAll("main").length,
            nav: document.querySelectorAll("nav").length,
          },
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
          unnamedButtons: unnamedButtonElements.length,
          unnamedInputs: unnamedInputElements.length,
          unnamedDetails: [...unnamedButtonElements, ...unnamedInputElements].map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/).slice(0, 3).join(".")}`).slice(0, 20),
          tinyTargets,
        };
      });
      report.push({ route, viewport: viewport.name, status: response?.status() ?? null, screenshot: imagePath, consoleErrors: [...consoleErrors], ...facts });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const item of report) {
  console.log(`${item.viewport.padEnd(7)} ${item.route.padEnd(11)} ${item.status} h1=${item.h1.length} main=${item.landmarks.main} overflow=${item.horizontalOverflow} tiny=${item.tinyTargets} unnamed=${item.unnamedButtons + item.unnamedInputs} errors=${item.consoleErrors.length}`);
}
