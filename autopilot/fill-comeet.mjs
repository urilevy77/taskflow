#!/usr/bin/env node
// Fills a Comeet application form in a VISIBLE browser and leaves it open. Never submits —
// the user reviews and clicks Submit (design/tailor-apply-plan.md, decision "Submit").
//   node autopilot/fill-comeet.mjs <job-url> <cv.pdf> [--cover <cover.pdf>]
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const [url, cv] = process.argv.slice(2);
if (!url || !cv) { console.log('usage: node autopilot/fill-comeet.mjs <job-url> <cv.pdf>'); process.exit(2); }
const yml = readFileSync(resolve(getCareerOpsRoot(), 'config', 'profile.yml'), 'utf-8');
const get = (k) => yml.match(new RegExp(`^\s+${k}:\s*"?([^"\n]*)"?`, 'm'))?.[1]?.trim() ?? '';
const [first, ...rest] = get('full_name').split(/\s+/);

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext()).newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('#showApplyForm').click({ force: true });
const form = page.frameLocator('iframe[src*="/apply"]');
await form.locator('#inputFirstName').waitFor({ timeout: 20000 });
await form.locator('#inputFirstName').fill(first);
await form.locator('#inputLastName').fill(rest.join(' '));
await form.locator('#inputEmail').fill(get('email'));
await form.locator('#inputTel').fill(get('phone').replace(/^\+972-?/, '0'));
await form.locator('#cv').setInputFiles(resolve(cv));
console.log('FILLED — review the window and click Submit yourself. Not submitted.');
await new Promise((r) => browser.on('disconnected', r));
