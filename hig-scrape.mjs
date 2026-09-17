import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const OUT = process.env.OUT;
const pages = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args:["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1200 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" });
const p = await ctx.newPage();
for (const slug of pages) {
  const url = slug.startsWith("http") ? slug
    : `https://developer.apple.com/design/human-interface-guidelines/${slug}`;
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForSelector("main, .content, #app .doc-content", { timeout: 30000 }).catch(()=>{});
    await p.waitForTimeout(2500);
    const text = await p.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      return main.innerText.replace(/\n{3,}/g, "\n\n");
    });
    const name = (slug.startsWith("http") ? new URL(url).pathname.replace(/\W+/g,"-") : slug) + ".txt";
    writeFileSync(`${OUT}/${name}`, `URL: ${url}\n\n${text}`);
    console.log(name, text.length);
  } catch (e) {
    console.log("FAIL", slug, e.message.slice(0, 80));
  }
}
await b.close();
