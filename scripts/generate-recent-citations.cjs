#!/usr/bin/env node
/**
 * Generate data/recent-citations.json using daily citation deltas (no extra API calls).
 *
 * Logic:
 * - Read today's works.csv (already fetched by cache/export).
 * - Load the latest snapshot in data/citation-snapshots/*.json (if any).
 * - Compare citations_today vs citations_prev; if increased, emit a feed item with addedAt=today.
 * - Merge today's new items with the existing recent-citations file, keeping a rolling window.
 * - Save today's snapshot for the next run.
 *
 * Environment (optional):
 * - RECENT_CITATIONS_WINDOW_DAYS: window for UI; defaults to 31 (UI also enforces).
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const worksCsvPath = path.join(root, "data", "works.csv");
const outputPath = path.join(root, "data", "recent-citations.json");
const snapshotsDir = path.join(root, "data", "citation-snapshots");

const todayIso = new Date().toISOString().slice(0, 10);
const windowDaysEnv = Number(process.env.RECENT_CITATIONS_WINDOW_DAYS || "");
const windowDays = Number.isFinite(windowDaysEnv) && windowDaysEnv > 0 ? windowDaysEnv : 31;

const ensureDir = (p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

const parseCsv = (text) => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(/,(?![^"]*"(?:(?:[^"]*"){2})*[^"]*$)/); // simple split
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || "").replace(/^"|"$/g, "");
    });
    return row;
  });
};

const readWorks = () => {
  if (!fs.existsSync(worksCsvPath)) throw new Error(`Missing works CSV at ${worksCsvPath}`);
  const csv = fs.readFileSync(worksCsvPath, "utf8");
  return parseCsv(csv);
};

const loadLatestSnapshot = () => {
  if (!fs.existsSync(snapshotsDir)) return null;
  const files = fs
    .readdirSync(snapshotsDir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // ISO date filenames sort ascending
  const latest = files.at(-1);
  if (!latest) return null;
  const full = path.join(snapshotsDir, latest);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return null;
  }
};

const writeSnapshot = (map) => {
  ensureDir(snapshotsDir);
  const file = path.join(snapshotsDir, `${todayIso}.json`);
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
};

const loadExistingFeed = () => {
  if (!fs.existsSync(outputPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

const withinWindow = (isoDate) => {
  const t = Date.parse(isoDate || "");
  if (Number.isNaN(t)) return false;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return t >= cutoff;
};

const main = () => {
  const works = readWorks();
  const prev = loadLatestSnapshot() || {};
  const currentSnapshot = {};
  const existingFeed = loadExistingFeed();
  const newFeedItems = [];

  for (const w of works) {
    const workId = w.work_id;
    if (!workId) continue;
    const citationsNow = Number(w.citations || 0);
    currentSnapshot[workId] = citationsNow;
    const prevCites = Number(prev[workId] || 0);
    if (citationsNow > prevCites) {
      newFeedItems.push({
        workId,
        doi: w.doi || "",
        title: w.title || "",
        venue: w.venue || "",
        publicationDate: w.publication_date || "",
        year: w.year ? Number(w.year) : undefined,
        allAuthors: (w.all_authors || "").split(";").map((s) => s.trim()).filter(Boolean),
        addedAt: todayIso,
        citedByCount: citationsNow - prevCites, // delta
        citationsTotal: citationsNow,
      });
    }
  }

  // Merge with existing feed, keeping the most recent entry per workId and trimming to window
  const merged = new Map();

  const pushItem = (item) => {
    if (!item.workId) return;
    const key = item.workId;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      return;
    }
    // Prefer newer addedAt; if same day, keep higher citedByCount
    const existingTime = Date.parse(existing.addedAt || "");
    const itemTime = Date.parse(item.addedAt || "");
    if (!Number.isNaN(itemTime) && itemTime > existingTime) {
      merged.set(key, item);
    } else if (itemTime === existingTime && (item.citedByCount || 0) > (existing.citedByCount || 0)) {
      merged.set(key, item);
    }
  };

  existingFeed.forEach((item) => {
    if (withinWindow(item.addedAt)) pushItem(item);
  });
  newFeedItems.forEach(pushItem);

  const finalFeed = Array.from(merged.values()).filter((item) => withinWindow(item.addedAt));
  finalFeed.sort((a, b) => Date.parse(b.addedAt || "") - Date.parse(a.addedAt || ""));

  fs.writeFileSync(outputPath, JSON.stringify(finalFeed, null, 2));
  writeSnapshot(currentSnapshot);

  console.log(
    `Wrote ${newFeedItems.length} new rows, ${finalFeed.length} total in window to ${outputPath} (snapshot ${todayIso}, prev snapshot ${
      Object.keys(prev).length ? "found" : "missing"
    }).`,
  );
};

main();
