import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { parse as parseHtml } from "node-html-parser";
import crypto from "node:crypto";
import { chromium } from "playwright";

const ROOT = process.cwd();
const COMPANIES_CSV = path.join(ROOT, "data", "companies.csv");

const RAW_JOBS_JSON = path.join(ROOT, "data", "raw_jobs.json");
const COVERAGE_JSON = path.join(ROOT, "site", "coverage.json");

function sha1(s){ return crypto.createHash("sha1").update(String(s)).digest("hex"); }
function clean(s){ return (s ?? "").toString().replace(/\s+/g, " ").trim(); }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return null; } }
function sameOriginOnly(baseUrl, url){
  try {
    const b = new URL(baseUrl);
    const u = new URL(url);
    return b.origin === u.origin;
  } catch { return false; }
}

function detectSource(url){
  const u = url.toLowerCase();
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("myworkday") || u.includes("workday")) return "workday";
  if (u.includes("ats.rippling.com")) return "rippling";
  if (u.includes("breezy.hr")) return "breezy";
  if (u.includes("builtinaustin.com")) return "built_in";
  if (u.includes("scalis.ai")) return "scalis";
  if (u.includes("notion.site")) return "custom_html";
  return "custom_html";
}

async function fetchText(url){
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (active-portfolio-jobs-bot)" }});
  return { ok: res.ok, status: res.status, url: res.url, text: await res.text() };
}

// ---------------- Providers ----------------

async function scrapeGreenhouse(company, careersUrl){
  const m = careersUrl.match(/greenhouse\.io\/(?:job-boards\.)?([^\/\?#]+)/i);
  const board = m?.[1];
  if (!board) throw new Error("Could not detect Greenhouse board slug");

  const api = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=false`;
  const res = await fetch(api, { headers: { "user-agent": "Mozilla/5.0 (active-portfolio-jobs-bot)" }});
  if (!res.ok) throw new Error(`Greenhouse API ${res.status}`);
  const data = await res.json();

  return (data.jobs ?? [])
    .map(j => ({
      portfolio: "Active Capital",
      company_name: company,
      company_careers_url: careersUrl,
      job_title: clean(j.title),
      job_location: clean(j.location?.name ?? "Not listed"),
      job_url: clean(j.absolute_url ?? ""),
      source_type: "greenhouse",
      source_job_id: String(j.id ?? ""),
      job_key: `greenhouse:${String(j.id ?? sha1(j.absolute_url ?? ""))}`,
      status: "open",
      last_seen_utc: new Date().toISOString(),
    }))
    .filter(j => j.job_url);
}

async function scrapeRippling(company, careersUrl){
  const { ok, text, status } = await fetchText(careersUrl);
  if (!ok) throw new Error(`Rippling fetch failed: ${status}`);
  const root = parseHtml(text);
  const anchors = root.querySelectorAll("a[href]");
  const out = [];

  for (const a of anchors){
    const href = a.getAttribute("href") || "";
    if (!href.includes("/jobs/")) continue;
    const url = absUrl(careersUrl, href);
    if (!url || !sameOriginOnly(careersUrl, url)) continue;
    const title = clean(a.text);
    if (!title) continue;
    out.push({
      portfolio: "Active Capital",
      company_name: company,
      company_careers_url: careersUrl,
      job_title: title,
      job_location: "Not listed",
      job_url: url,
      source_type: "rippling",
      source_job_id: sha1(url),
      job_key: `rippling:${sha1(url)}`,
      status: "open",
      last_seen_utc: new Date().toISOString(),
    });
  }

  // de-dupe by url
  const seen = new Set();
  return out.filter(j => (seen.has(j.job_url) ? false : (seen.add(j.job_url), true)));
}

async function scrapeBreezy(company, careersUrl){
  const { ok, text, status } = await fetchText(careersUrl);
  if (!ok) throw new Error(`Breezy fetch failed: ${status}`);
  const root = parseHtml(text);
  const anchors = root.querySelectorAll("a[href]");
  const out = [];

  for (const a of anchors){
    const href = a.getAttribute("href") || "";
    if (!href.includes("/p/")) continue;
    const url = absUrl(careersUrl, href);
    if (!url || !sameOriginOnly(careersUrl, url)) continue;
    const title = clean(a.text);
    if (!title || title.toLowerCase() === "apply") continue;
    out.push({
      portfolio: "Active Capital",
      company_name: company,
      company_careers_url: careersUrl,
      job_title: title,
      job_location: "Not listed",
      job_url: url,
      source_type: "breezy",
      source_job_id: sha1(url),
      job_key: `breezy:${sha1(url)}`,
      status: "open",
      last_seen_utc: new Date().toISOString(),
    });
  }

  const seen = new Set();
  return out.filter(j => (seen.has(j.job_url) ? false : (seen.add(j.job_url), true)));
}

async function scrapeBuiltIn(company, careersUrl){
  const { ok, text, status } = await fetchText(careersUrl);
  if (!ok) throw new Error(`Built In fetch failed: ${status}`);
  const root = parseHtml(text);
  const anchors = root.querySelectorAll("a[href]");
  const out = [];

  for (const a of anchors){
    const href = a.getAttribute("href") || "";
    const url = absUrl(careersUrl, href);
    if (!url || !sameOriginOnly(careersUrl, url)) continue;
    if (!/\/(job|jobs)\//i.test(url)) continue;
    const title = clean(a.text);
    if (!title || title.length < 3) continue;
    out.push({
      portfolio: "Active Capital",
      company_name: company,
      company_careers_url: careersUrl,
      job_title: title,
      job_location: "Not listed",
      job_url: url,
      source_type: "built_in",
      source_job_id: sha1(url),
      job_key: `built_in:${sha1(url)}`,
      status: "open",
      last_seen_utc: new Date().toISOString(),
    });
  }

  const seen = new Set();
  return out.filter(j => (seen.has(j.job_url) ? false : (seen.add(j.job_url), true)));
}

async function scrapeAshby(company, careersUrl){
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (active-portfolio-jobs-bot)" });
  try {
    await page.goto(careersUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    // Ashby job links are same-origin and include a UUID.
    const jobs = await page.evaluate(() => {
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const out = [];
      for (const a of anchors){
        const href = a.getAttribute('href') || '';
        if (!href) continue;
        const url = new URL(href, window.location.href).toString();
        if (new URL(url).origin !== window.location.origin) continue;
        if (!uuidRe.test(url)) continue;

        const title = (a.textContent || '').replace(/\s+/g,' ').trim();
        if (!title) continue;

        // Try to grab the surrounding card text for hints (location/remote)
        const card = a.closest('div') || a.parentElement;
        const cardText = (card?.textContent || '').replace(/\s+/g,' ').trim();
        out.push({ url, title, cardText });
      }
      return out;
    });

    const cleaned = [];
    const seen = new Set();

    for (const j of jobs){
      if (seen.has(j.url)) continue;
      seen.add(j.url);

      // Pull a crude location hint from the card text
      let loc = "Not listed";
      const ct = (j.cardText || "").toLowerCase();
      if (ct.includes(" remote ") || ct.startsWith("remote")) loc = "Remote";
      else if (ct.includes(" hybrid ") || ct.startsWith("hybrid")) loc = "Hybrid";

      cleaned.push({
        portfolio: "Active Capital",
        company_name: company,
        company_careers_url: careersUrl,
        job_title: clean(j.title),
        job_location: loc,
        job_url: j.url,
        source_type: "ashby",
        source_job_id: sha1(j.url),
        job_key: `ashby:${sha1(j.url)}`,
        status: "open",
        last_seen_utc: new Date().toISOString(),
      });
    }

    return cleaned;
  } finally {
    await page.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function scrapeWorkday(company, careersUrl){
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (active-portfolio-jobs-bot)" });
  try {
    await page.goto(careersUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);

    const jobs = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/job/"]'));
      const out = [];
      for (const a of anchors){
        const href = a.getAttribute('href') || '';
        if (!href) continue;

        const url = new URL(href, window.location.href).toString();
        if (new URL(url).origin !== window.location.origin) continue;

        const title = (a.textContent || '').replace(/\s+/g,' ').trim();
        if (!title || title.length < 3) continue;

        out.push({ url, title });
      }
      return out;
    });

    const out = [];
    const seen = new Set();
    for (const j of jobs){
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      out.push({
        portfolio: "Active Capital",
        company_name: company,
        company_careers_url: careersUrl,
        job_title: clean(j.title),
        job_location: "Not listed",
        job_url: j.url,
        source_type: "workday",
        source_job_id: sha1(j.url),
        job_key: `workday:${sha1(j.url)}`,
        status: "open",
        last_seen_utc: new Date().toISOString(),
      });
    }

    return out;
  } finally {
    await page.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function scrapeScalis(company, careersUrl){
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (active-portfolio-jobs-bot)" });

  try {
    await page.goto(careersUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);

    const jobs = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/job/"]'));
      const out = [];
      for (const a of anchors){
        const href = a.getAttribute("href") || "";
        if (!href) continue;

        const url = new URL(href, window.location.href).toString();
        if (new URL(url).origin !== window.location.origin) continue;
        if (!/\/job\/[0-9a-f-]{20,}/i.test(url)) continue;

        const title = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (!title || title.length < 3) continue;

        out.push({ url, title });
      }
      return out;
    });

    const out = [];
    const seen = new Set();
    for (const j of jobs){
      if (seen.has(j.url)) continue;
      seen.add(j.url);

      out.push({
        portfolio: "Active Capital",
        company_name: company,
        company_careers_url: careersUrl,
        job_title: clean(j.title),
        job_location: "Not listed",
        job_url: j.url,
        source_type: "scalis",
        source_job_id: sha1(j.url),
        job_key: `scalis:${sha1(j.url)}`,
        status: "open",
        last_seen_utc: new Date().toISOString(),
      });
    }

    return out;
  } finally {
    await page.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function scrapeCustomHtml(company, careersUrl){
  const { ok, text, status } = await fetchText(careersUrl);
  if (!ok) throw new Error(`Custom HTML fetch failed: ${status}`);
  const root = parseHtml(text);

  const allowPath = /(\/job\/|\/jobs\/|\/positions\/|\/openings\/|\/careers\/|\/careers$)/i;
  const blockPath = /(privacy|security|disclosure|login|signup|terms|cookie|press|blog|about|product|pricing)/i;
  
  const anchors = root.querySelectorAll("a[href]");
  const out = [];
  const seen = new Set();

  for (const a of anchors){
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#")) continue;
    const url = absUrl(careersUrl, href);
    if (!url || !sameOriginOnly(careersUrl, url)) continue;
    if (blockPath.test(url)) continue;

    const u = new URL(url);
    if (!allowPath.test(u.pathname)) continue;
    if (u.pathname.replace(/\/+$/,'') === new URL(careersUrl).pathname.replace(/\/+$/,'')) continue;

   let title = clean(a.text);

    // If the title is glued to the description like "AI EngineerAs..."
    title = title.replace(/([a-z])As\b/g, "$1 As");
    
    // Now trim description bleed
    title = title
      .split(/\bAs (an|a|our)\b/i)[0]
      .split(/\bAustin, or\b/i)[0] // Dreambase-specific: location starts
      .split("•")[0]
      .split("|")[0]
      .split("—")[0]
      .trim();
    
    // If still too long, take first line-ish chunk
    if (title.length > 80) {
      title = title.split(/[.!?]/)[0].trim(); // take first sentence fragment
    }
    
    // Final safety: cap words
    if (title.length > 80) {
      title = title.split(/\s+/).slice(0, 10).join(" ").trim();
    }
    
    if (!title || title.length < 6) continue;
    if (title.split(/\s+/).length < 2) continue;

    
    out.push({
      portfolio: "Active Capital",
      company_name: company,
      company_careers_url: careersUrl,
      job_title: title,
      job_location: "Not listed",
      job_url: url,
      source_type: "custom_html",
      source_job_id: sha1(url),
      job_key: `custom_html:${sha1(url)}`,
      status: "open",
      last_seen_utc: new Date().toISOString(),
    });
  }

  return out;
}

// ---------------- Orchestration ----------------

async function readCompanies(){
  const csvText = await fs.readFile(COMPANIES_CSV, "utf-8");
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  return rows
    .map(r => ({ company_name: clean(r.company_name), careers_url: clean(r.careers_url) }))
    .filter(r => r.company_name && r.careers_url);
}

async function main(){
  await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
  await fs.mkdir(path.join(ROOT, "site"), { recursive: true });

  const companies = await readCompanies();

  const rawJobs = [];
  const coverage = [];

  for (const c of companies){
    const source = detectSource(c.careers_url);
    let jobs = [];
    let status = "ok";
    let error = "";

       try {
      if (source === "greenhouse") jobs = await scrapeGreenhouse(c.company_name, c.careers_url);
      else if (source === "rippling") jobs = await scrapeRippling(c.company_name, c.careers_url);
      else if (source === "breezy") jobs = await scrapeBreezy(c.company_name, c.careers_url);
      else if (source === "built_in") jobs = await scrapeBuiltIn(c.company_name, c.careers_url);
      else if (source === "ashby") jobs = await scrapeAshby(c.company_name, c.careers_url);
      else if (source === "workday") jobs = await scrapeWorkday(c.company_name, c.careers_url);
      else if (source === "scalis") jobs = await scrapeScalis(c.company_name, c.careers_url);
      else if (source === "custom_html") jobs = await scrapeCustomHtml(c.company_name, c.careers_url);
      else {
        status = "unsupported";
        jobs = [];
      }
    } catch (e) {
      status = "failed";
      error = String(e?.message || e);
      jobs = [];
    }

    if (status === "ok" && jobs.length === 0) status = "empty";

    coverage.push({
      portfolio: "Active Capital",
      company_name: c.company_name,
      company_careers_url: c.careers_url,
      source_type: source,
      status,
      open_roles_raw: jobs.length,
      error,
      last_checked_utc: new Date().toISOString(),
    });

    rawJobs.push(...jobs);

    console.log(`[${status.toUpperCase()}] ${c.company_name} (${source}) -> ${jobs.length}`);
  }

  // global de-dupe by job_key
  const seen = new Set();
  const deduped = [];
  for (const j of rawJobs){
    const k = j.job_key || `${j.source_type}:${j.source_job_id}` || sha1(j.job_url);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(j);
  }

  await fs.writeFile(RAW_JOBS_JSON, JSON.stringify(deduped, null, 2) + "\n", "utf-8");
  await fs.writeFile(COVERAGE_JSON, JSON.stringify(coverage, null, 2) + "\n", "utf-8");

  console.log(`Wrote ${deduped.length} raw jobs for ${companies.length} companies.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
