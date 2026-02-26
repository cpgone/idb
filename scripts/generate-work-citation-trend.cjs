// Generate per-work citation trend data from cached OpenAlex author data.
//
// Usage:
//   node scripts/generate-work-citation-trend.cjs
//
// Reads:
//   public/author-data/*.json
// Writes:
//   src/data/workCitationTrend.generated.ts

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const authorDataDir = path.join(ROOT, "public", "author-data");
const outPath = path.join(ROOT, "src", "data", "workCitationTrend.generated.ts");

const canonicalOpenAlexWorkId = (raw) => {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (/^https?:\/\/(www\.)?openalex\.org\//i.test(trimmed)) return trimmed;
  return `https://openalex.org/${trimmed.replace(/^W/i, "W")}`;
};

const toInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const main = () => {
  if (!fs.existsSync(authorDataDir)) {
    console.error(`No ${path.relative(ROOT, authorDataDir)} directory found.`);
    process.exit(1);
  }

  const fileNames = fs.readdirSync(authorDataDir).filter((name) => name.toLowerCase().endsWith(".json"));
  const countsByWork = new Map();

  for (const fileName of fileNames) {
    const filePath = path.join(authorDataDir, fileName);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.warn(`Skipping invalid JSON: ${path.relative(ROOT, filePath)}`);
      continue;
    }

    const works = Array.isArray(payload?.works) ? payload.works : [];
    for (const work of works) {
      const workId = canonicalOpenAlexWorkId(work?.id);
      if (!workId) continue;

      const yearlyCounts = Array.isArray(work?.counts_by_year) ? work.counts_by_year : [];
      if (!yearlyCounts.length) continue;

      let yearMap = countsByWork.get(workId);
      if (!yearMap) {
        yearMap = new Map();
        countsByWork.set(workId, yearMap);
      }

      for (const row of yearlyCounts) {
        const year = toInt(row?.year);
        const citedByCount = Math.max(0, toInt(row?.cited_by_count));
        if (year <= 0) continue;
        const prev = yearMap.get(year) || 0;
        if (citedByCount > prev) yearMap.set(year, citedByCount);
      }
    }
  }

  const records = [];
  for (const [workId, yearMap] of countsByWork.entries()) {
    const years = Array.from(yearMap.keys()).sort((a, b) => a - b);
    if (!years.length) continue;

    const latestYear = years[years.length - 1];
    const previousYear = latestYear - 1;
    const latestYearCitations = yearMap.get(latestYear) || 0;
    const previousYearCitations = yearMap.get(previousYear) || 0;
    const yearOverYearDelta = latestYearCitations - previousYearCitations;

    records.push({
      workId,
      latestYear,
      latestYearCitations,
      previousYearCitations,
      yearOverYearDelta,
    });
  }

  records.sort((a, b) => a.workId.localeCompare(b.workId));

  const byWorkId = {};
  for (const record of records) {
    byWorkId[record.workId] = record;
  }

  const fileContents =
    "// AUTO-GENERATED FILE. DO NOT EDIT.\n" +
    "// Generated from public/author-data/*.json by scripts/generate-work-citation-trend.cjs\n\n" +
    "export interface WorkCitationTrendRecord {\n" +
    "  workId: string;\n" +
    "  latestYear: number;\n" +
    "  latestYearCitations: number;\n" +
    "  previousYearCitations: number;\n" +
    "  yearOverYearDelta: number;\n" +
    "}\n\n" +
    `export const workCitationTrendByWorkId: Record<string, WorkCitationTrendRecord> = ${JSON.stringify(
      byWorkId,
      null,
      2,
    )};\n`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fileContents, "utf8");

  console.log(
    `Generated ${path.relative(ROOT, outPath)} from ${path.relative(ROOT, authorDataDir)} (${records.length.toLocaleString()} works).`,
  );
};

main();
