#!/usr/bin/env node
// Safe screenshot helper — URL and output path passed as process arguments, not shell-interpolated
import puppeteer from "puppeteer";

const [url, outputPath] = process.argv.slice(2);
if (!url || !outputPath) {
  process.stderr.write("Usage: screenshot.mjs <url> <outputPath>\n");
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
await page.screenshot({ path: outputPath, fullPage: false });
await browser.close();
