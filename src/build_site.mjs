import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import crypto from "node:crypto";

const ROOT = process.cwd();
const RAW_JOBS_JSON = path.join(ROOT, "data", "raw_jobs.json");
const COMPANIES_CSV = path.join(ROOT, "data", "companies.csv");

const OUT_DIR = path.join(ROOT, "site");
const COMPANIES_JSON = path.join(OUT_DIR, "companies.json");
const CLEAN_JOBS_JSON = path.join(OUT_DIR, "jobs.json");
const REJECTED_JOBS_JSON = path.join(OUT_DIR, "rejected_jobs.json");
const LAST_UPDATED_JSON = path.join(OUT_DIR, "last_updated.json");

function sha1(s){
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function cleanText(s){
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function looksLikeJobTitle(title){
  const t = title.toLowerCase();
  // keep this permissive: we don't want to accidentally delete real jobs
  return ![
    "careers",
    "get in touch",
    "get started",
    "log in",
    "login",
    "privacy policy",
    "security",
    "vulnerability disclosure",
    "powered by ashby",
  ].includes(t);
}

function normalizeJob(job){
  let title = cleanText(job.job_title);
  let location = cleanText(job.job_location);

  // Drop obvious junk titles + junk URLs
  if (!title || title.length < 3) return null;
  if (!looksLikeJobTitle(title)) return null;
  if (job.job_url && /(privacy|security|disclosure|login|signup|ashbyhq\.com\/?$)/i.test(job.job_url)) return null;

// Drop templating/placeholder junk (seen on Breezy / embedded boards)
if (/%[A-Z0-9_]+%/.test(title)) return null;

// If title looks like a paragraph, cut aggressively
title = title.split("\n")[0].trim();
title = title.split("Responsibilities")[0].trim();
title = title.split("Description")[0].trim();
title = title.split("About the role")[0].trim();

// If still long, cut after common separators
if (title.length > 90) {
  title = title.split(" — ")[0].split(" - ")[0].split(" | ")[0].trim();
}

// Remove trailing department labels that get appended (Ashby often does this)
title = title.replace(/\s+\b(Engineering|Marketing|Sales|Product|Operations|Finance|People|Legal|Design|Support)\b\s*$/i, "").trim();
title = title.replace(/\s*-\s*\b(Engineering|Marketing|Sales|Product|Operations|Finance|People|Legal|Design|Support)\b\s*$/i, "").trim();

// Location sanity: drop non-location qualifiers like "Forward Deployed"
if (/\bforward deployed\b/i.test(location)) location = "Not listed";
  
  // Work-mode detection (for Ashby/others that shove it into title)
  const lower = title.toLowerCase();
  const isRemote = /\bremote\b/.test(lower);
  const isHybrid = /\bhybrid\b/.test(lower);
  const isOnsite = /\bon[-\s]?site\b|\bonsite\b/.test(lower);

  // If the title contains Ashby bullets, keep only the left side
  if (title.includes("•")){
    title = title.split("•")[0].trim();
  }

  // Remove comp / equity / time noise often appended
  title = title
    .replace(/\$?\d{2,3}\s?[kK]\s?[–-]\s?\$?\d{2,3}\s?[kK].*$/g, "")
    .replace(/£\s?\d.*$/g, "")
    .replace(/\bOffers Equity\b.*$/i, "")
    .replace(/\bFull[-\s]?time\b.*$/i, "")
    .trim();

  // Simple geo hint extraction
  const geoHint =
    title.match(/-\s*([A-Za-z .()]{3,40})$/)?.[1]?.trim() ||
    title.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ||
    "";

  // Strip trailing department words
  title = title.replace(/\b(Engineering|Marketing|Sales|Product|Operations|Finance|People|Legal|Design|Support)\b$/i, "").trim();

  const missingLoc = !location || location.toLowerCase() === "not listed";
  if (missingLoc){
    if (isRemote && geoHint) location = `Remote — ${geoHint}`;
    else if (isRemote) location = "Remote";
    else if (isHybrid && geoHint) location = `Hybrid — ${geoHint}`;
    else if (isHybrid) location = "Hybrid";
    else if (isOnsite && geoHint) location = geoHint;
    else if (isOnsite) location = "On-site";
    else if (geoHint) location = geoHint;
  } else {
    if (isRemote && !location.toLowerCase().includes("remote")) location = `Remote — ${location}`;
  }

  return {
    ...job,
    job_title: title,
    job_location: location || "Not listed",
  };
}

async function readCompanies(){
  const csvText = await fs.readFile(COMPANIES_CSV, "utf-8");
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  return rows
    .map(r => ({
      company_name: cleanText(r.company_name),
      careers_url: cleanText(r.careers_url),
    }))
    .filter(r => r.company_name && r.careers_url);
}

async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const companies = await readCompanies();
  const raw = JSON.parse(await fs.readFile(RAW_JOBS_JSON, "utf-8"));

  const cleaned = [];
  const rejected = [];
  for (const j of raw){
    const nj = normalizeJob(j);
    if (nj) cleaned.push(nj);
    else rejected.push(j);
  }

  // Create company index, even if 0 jobs
  const byCompany = new Map();
  for (const c of companies) byCompany.set(c.company_name, 0);
  for (const j of cleaned) byCompany.set(j.company_name, (byCompany.get(j.company_name) || 0) + 1);

  const companiesOut = companies.map(c => ({
    portfolio: "Active Capital",
    company_name: c.company_name,
    company_careers_url: c.careers_url,
    open_roles: byCompany.get(c.company_name) || 0,
  }));

  cleaned.sort((a,b)=> (a.company_name.localeCompare(b.company_name) || a.job_title.localeCompare(b.job_title)));

  await fs.writeFile(COMPANIES_JSON, JSON.stringify(companiesOut, null, 2) + "\n", "utf-8");
  await fs.writeFile(CLEAN_JOBS_JSON, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
  await fs.writeFile(REJECTED_JOBS_JSON, JSON.stringify(rejected, null, 2) + "\n", "utf-8");
  await fs.writeFile(LAST_UPDATED_JSON, JSON.stringify({ last_updated_utc: new Date().toISOString(), raw_count: raw.length, clean_count: cleaned.length }, null, 2) + "\n", "utf-8");

  console.log(`Built site outputs: ${cleaned.length} jobs (from ${raw.length} raw).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
