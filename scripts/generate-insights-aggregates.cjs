// Aggregate topic insights by year for global and per-author views.
//
// Usage:
//   node scripts/generate-insights-aggregates.cjs
//
// Reads:
//   data/works.csv
//   data/work_topics.csv
//   data/config/blacklist.csv
// Writes:
//   src/data/insightsAggregates.generated.ts

const fs = require("fs");
const path = require("path");
const { repairUtf8 } = require("./lib/textRepair.cjs");

const ROOT = path.resolve(__dirname, "..");
const worksPath = path.join(ROOT, "data", "works.csv");
const workTopicsPath = path.join(ROOT, "data", "work_topics.csv");
const blacklistPath = path.join(ROOT, "data", "config", "blacklist.csv");
const insightsConfigPath = path.join(ROOT, "data", "config", "insightsconfig.json");
const outPath = path.join(ROOT, "src", "data", "insightsAggregates.generated.ts");
const outTopicCsvPath = path.join(ROOT, "data", "insights_topic_year.csv");
const outAuthorCsvPath = path.join(ROOT, "data", "insights_author_topic_year.csv");
const outTopicLabelsCsvPath = path.join(ROOT, "data", "insights_topic_labels.csv");
const outAuthorLabelsCsvPath = path.join(ROOT, "data", "insights_author_topic_labels.csv");

const parseCsvLine = (line) => {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  result.push(current);
  return result;
};

const readCsv = (filePath) => {
  if (!fs.existsSync(filePath)) return { headers: [], rows: [] };

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]).map((h) => repairUtf8(h.trim()));
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line).map((v) => repairUtf8(v.trim()));
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = values[idx] ?? "";
    });
    return record;
  });

  return { headers, rows };
};

const normalizeId = (value) => (value || "").trim().toLowerCase();
const canonicalWorkId = (value) =>
  normalizeId(value).replace(/^https?:\/\/(www\.)?openalex\.org\//, "");
const canonicalDoi = (value) =>
  normalizeId(value)
    .replace(/^https?:\/\/(www\.)?doi\.org\//, "")
    .replace(/^doi:/, "");
const slugify = (raw) => {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{M}+/gu, "");
  s = s.replace(/[\u2010-\u2015]/g, "-");
  s = s.replace(/[^\w\s-]/g, " ");
  s = s.replace(/\s+/g, " ");
  s = s.trim().replace(/\s+/g, "-");
  return s;
};

const parseBlacklist = () => {
  if (!fs.existsSync(blacklistPath)) return [];
  const lines = fs
    .readFileSync(blacklistPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const entries = [];
  if (lines.length <= 1) return entries;

  const unquote = (s) => s.replace(/^"(.*)"$/, "$1");
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length < 5) continue;
    const [scopeRaw, authorId, workId, doi, titleSlug] = cols.map(unquote);
    const scope = scopeRaw === "per-author" ? "per-author" : "global";
    entries.push({
      scope,
      authorId: normalizeId(authorId) || undefined,
      workId: canonicalWorkId(workId) || undefined,
      doi: canonicalDoi(doi) || undefined,
      titleSlug: normalizeId(titleSlug) || undefined,
    });
  }
  return entries;
};

const buildBlacklistIndex = () => {
  const entries = parseBlacklist();
  const globalIds = new Set();
  const globalDois = new Set();
  const globalSlugs = new Set();

  const perAuthorIds = new Map();
  const perAuthorDois = new Map();
  const perAuthorSlugs = new Map();

  const addToMap = (map, key, value) => {
    const existing = map.get(key) || new Set();
    existing.add(value);
    map.set(key, existing);
  };

  for (const entry of entries) {
    if (entry.scope === "global") {
      if (entry.workId) globalIds.add(entry.workId);
      if (entry.doi) globalDois.add(entry.doi);
      if (entry.titleSlug) globalSlugs.add(entry.titleSlug);
    } else if (entry.scope === "per-author" && entry.authorId) {
      if (entry.workId) addToMap(perAuthorIds, entry.authorId, entry.workId);
      if (entry.doi) addToMap(perAuthorDois, entry.authorId, entry.doi);
      if (entry.titleSlug) addToMap(perAuthorSlugs, entry.authorId, entry.titleSlug);
    }
  }

  const isBlacklisted = (workId, doi, titleSlug, authorId) => {
    const id = canonicalWorkId(workId);
    const doiKey = canonicalDoi(doi);
    const slug = normalizeId(titleSlug);

    if (id && globalIds.has(id)) return true;
    if (doiKey && globalDois.has(doiKey)) return true;
    if (slug && globalSlugs.has(slug)) return true;

    const authorKey = normalizeId(authorId);
    if (authorKey) {
      if (id && (perAuthorIds.get(authorKey)?.has(id) ?? false)) return true;
      if (doiKey && (perAuthorDois.get(authorKey)?.has(doiKey) ?? false)) return true;
      if (slug && (perAuthorSlugs.get(authorKey)?.has(slug) ?? false)) return true;
    }

    return false;
  };

  return { isBlacklisted };
};

const main = () => {
  const { headers: workHeaders, rows: workRows } = readCsv(worksPath);
  if (!workHeaders.length) {
    console.error("No data/works.csv found or file is empty.");
    process.exit(1);
  }

  const { headers: topicHeaders, rows: topicRows } = readCsv(workTopicsPath);
  if (!topicHeaders.length) {
    console.warn("Warning: data/work_topics.csv is empty; insights aggregates will be empty.");
  }

  const workIdKey = workHeaders.find((h) => h.toLowerCase() === "work_id") || "work_id";
  const doiKey = workHeaders.find((h) => h.toLowerCase() === "doi") || "doi";
  const titleKey = workHeaders.find((h) => h.toLowerCase() === "title") || "title";
  const yearKey = workHeaders.find((h) => h.toLowerCase() === "year") || "year";
  const citationsKey = workHeaders.find((h) => h.toLowerCase() === "citations") || "citations";
  const authorOpenAlexIdKey =
    workHeaders.find((h) => h.toLowerCase() === "author_openalex_id") ||
    "author_openalex_id";
  const coauthorOpenAlexIdsKey =
    workHeaders.find((h) => h.toLowerCase() === "coauthor_openalex_ids") ||
    "coauthor_openalex_ids";

  const topicWorkIdKey =
    topicHeaders.find((h) => h.toLowerCase() === "work_id") || "work_id";
  const topicNameKey =
    topicHeaders.find((h) => h.toLowerCase() === "topic_name") || "topic_name";

  const topicsByWorkId = new Map();
  for (const row of topicRows) {
    const workId = row[topicWorkIdKey];
    const topicName = row[topicNameKey];
    if (!workId || !topicName) continue;
    const list = topicsByWorkId.get(workId) ?? new Set();
    list.add(topicName);
    topicsByWorkId.set(workId, list);
  }

  const { isBlacklisted } = buildBlacklistIndex();

  const globalMap = new Map();
  const authorMap = new Map();

  const bump = (map, year, cites) => {
    const existing = map.get(year) || { pubs: 0, cites: 0 };
    existing.pubs += 1;
    existing.cites += cites;
    map.set(year, existing);
  };

  for (const row of workRows) {
    const workId = row[workIdKey] || "";
    if (!workId) continue;

    const year = Number(row[yearKey] || "0");
    if (!Number.isFinite(year) || year <= 0) continue;

    const citations = Number(row[citationsKey] || "0");
    const cites = Number.isFinite(citations) ? citations : 0;
    const doi = row[doiKey] || "";
    const title = row[titleKey] || "";
    const titleSlug = slugify(`${title} ${year}`);

    if (isBlacklisted(workId, doi, titleSlug)) continue;

    const topics = topicsByWorkId.get(workId);
    if (!topics || topics.size === 0) continue;

    const primaryAuthorOpenAlexId = (row[authorOpenAlexIdKey] || "").trim();
    const coauthorIdsRaw = row[coauthorOpenAlexIdsKey] || "";
    const coauthorOpenAlexIds = coauthorIdsRaw
      ? coauthorIdsRaw
          .split("|")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const allAuthorOpenAlexIds = [
      primaryAuthorOpenAlexId,
      ...coauthorOpenAlexIds,
    ].filter((s) => s.length > 0);

    for (const topic of topics) {
      const topicMap = globalMap.get(topic) || new Map();
      bump(topicMap, year, cites);
      globalMap.set(topic, topicMap);

      for (const authorId of allAuthorOpenAlexIds) {
        if (isBlacklisted(workId, doi, titleSlug, authorId)) continue;
        const authorTopicMap = authorMap.get(authorId) || new Map();
        const authorYearMap = authorTopicMap.get(topic) || new Map();
        bump(authorYearMap, year, cites);
        authorTopicMap.set(topic, authorYearMap);
        authorMap.set(authorId, authorTopicMap);
      }
    }
  }

  const topicYearStats = [];
  for (const [topic, yearMap] of globalMap.entries()) {
    for (const [year, stats] of yearMap.entries()) {
      topicYearStats.push({
        topic,
        year,
        pubs: stats.pubs,
        cites: stats.cites,
      });
    }
  }

  const authorTopicYearStats = [];
  for (const [authorOpenAlexId, topicMap] of authorMap.entries()) {
    for (const [topic, yearMap] of topicMap.entries()) {
      for (const [year, stats] of yearMap.entries()) {
        authorTopicYearStats.push({
          authorOpenAlexId,
          topic,
          year,
          pubs: stats.pubs,
          cites: stats.cites,
        });
      }
    }
  }

  topicYearStats.sort((a, b) => a.topic.localeCompare(b.topic) || a.year - b.year);
  authorTopicYearStats.sort(
    (a, b) =>
      a.authorOpenAlexId.localeCompare(b.authorOpenAlexId) ||
      a.topic.localeCompare(b.topic) ||
      a.year - b.year,
  );

  const fileContents =
    "// AUTO-GENERATED FILE. DO NOT EDIT.\n" +
    "// Generated from data/works.csv and data/work_topics.csv by scripts/generate-insights-aggregates.cjs\n\n" +
    "export interface TopicYearStats {\n" +
    "  topic: string;\n" +
    "  year: number;\n" +
    "  pubs: number;\n" +
    "  cites: number;\n" +
    "}\n\n" +
    "export interface AuthorTopicYearStats {\n" +
    "  authorOpenAlexId: string;\n" +
    "  topic: string;\n" +
    "  year: number;\n" +
    "  pubs: number;\n" +
    "  cites: number;\n" +
    "}\n\n" +
    `export const topicYearStats: TopicYearStats[] = ${JSON.stringify(
      topicYearStats,
      null,
      2,
    )};\n\n` +
    `export const authorTopicYearStats: AuthorTopicYearStats[] = ${JSON.stringify(
      authorTopicYearStats,
      null,
      2,
    )};\n`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fileContents, "utf8");

  const writeCsv = (filePath, headers, rows) => {
    const lines = [headers.join(",")];
    rows.forEach((row) => {
      const line = headers
        .map((key) => {
          const raw = row[key];
          if (raw == null) return "";
          const value = String(raw);
          if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
          return value;
        })
        .join(",");
      lines.push(line);
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  };

  writeCsv(outTopicCsvPath, ["topic", "year", "pubs", "cites"], topicYearStats);
  writeCsv(
    outAuthorCsvPath,
    ["author_openalex_id", "topic", "year", "pubs", "cites"],
    authorTopicYearStats.map((row) => ({
      author_openalex_id: row.authorOpenAlexId,
      topic: row.topic,
      year: row.year,
      pubs: row.pubs,
      cites: row.cites,
    })),
  );

  const insightsConfig = fs.existsSync(insightsConfigPath)
    ? JSON.parse(fs.readFileSync(insightsConfigPath, "utf8"))
    : {};

  const allYears = topicYearStats.map((row) => row.year);
  const minYear = allYears.length ? Math.min(...allYears) : null;
  const maxYear = allYears.length ? Math.max(...allYears) : null;
  const clampYear = (value) => {
    if (value == null || Number.isNaN(value) || minYear == null || maxYear == null) return null;
    return Math.min(Math.max(value, minYear), maxYear);
  };
  const defaultsA = insightsConfig?.insightsDefaultPeriodA || {};
  const defaultsB = insightsConfig?.insightsDefaultPeriodB || {};
  const periodA = {
    from: clampYear(defaultsA.from) ?? minYear,
    to: clampYear(defaultsA.to) ?? maxYear,
  };
  const periodB = {
    from: clampYear(defaultsB.from) ?? minYear,
    to: clampYear(defaultsB.to) ?? maxYear,
  };

  const classifyInsight = (pubsA, pubsB, citesA, citesB) => {
    const pubsRatio = pubsA === 0 ? (pubsB > 0 ? Infinity : 0) : pubsB / pubsA;
    const citesRatio = citesA === 0 ? (citesB > 0 ? Infinity : 0) : citesB / citesA;

    if (pubsA === 0 && pubsB > 0) return "Emerging";
    if (pubsB === 0) return "Declining";
    if (pubsRatio < 0.8 || citesRatio < 0.8) return "Declining";
    if (pubsRatio >= 2 && citesRatio >= 2) return "Strong surge";
    if (pubsRatio >= 1 && citesRatio >= 1) return "Growing priority";
    if (pubsRatio >= 1 && citesRatio < 1) return "Output rising, impact softening";
    if (citesRatio >= 1 && pubsRatio < 1) return "Impact-led";
    return "Stable";
  };

  const sumStatsByPeriod = (rows, from, to, getTopic) => {
    const map = new Map();
    rows.forEach((row) => {
      const topic = getTopic(row);
      const year = row.year;
      if (from != null && year < from) return;
      if (to != null && year > to) return;
      const current = map.get(topic) || { pubs: 0, cites: 0 };
      current.pubs += row.pubs;
      current.cites += row.cites;
      map.set(topic, current);
    });
    return map;
  };

  const globalAggA = sumStatsByPeriod(topicYearStats, periodA.from, periodA.to, (row) => row.topic);
  const globalAggB = sumStatsByPeriod(topicYearStats, periodB.from, periodB.to, (row) => row.topic);
  const allTopics = new Set([...globalAggA.keys(), ...globalAggB.keys()]);
  const topicLabels = Array.from(allTopics)
    .map((topic) => {
      const a = globalAggA.get(topic) || { pubs: 0, cites: 0 };
      const b = globalAggB.get(topic) || { pubs: 0, cites: 0 };
      return {
        topic,
        period_a_from: periodA.from,
        period_a_to: periodA.to,
        period_b_from: periodB.from,
        period_b_to: periodB.to,
        pubs_a: a.pubs,
        pubs_b: b.pubs,
        cites_a: a.cites,
        cites_b: b.cites,
        label: classifyInsight(a.pubs, b.pubs, a.cites, b.cites),
      };
    })
    .sort((a, b) => a.topic.localeCompare(b.topic));

  const authorKey = (row) => `${row.authorOpenAlexId}|||${row.topic}`;
  const authorAggA = sumStatsByPeriod(authorTopicYearStats, periodA.from, periodA.to, authorKey);
  const authorAggB = sumStatsByPeriod(authorTopicYearStats, periodB.from, periodB.to, authorKey);
  const authorTopics = new Set([...authorAggA.keys(), ...authorAggB.keys()]);
  const authorLabels = Array.from(authorTopics)
    .map((key) => {
      const [authorOpenAlexId, topic] = key.split("|||");
      const a = authorAggA.get(key) || { pubs: 0, cites: 0 };
      const b = authorAggB.get(key) || { pubs: 0, cites: 0 };
      return {
        author_openalex_id: authorOpenAlexId,
        topic,
        period_a_from: periodA.from,
        period_a_to: periodA.to,
        period_b_from: periodB.from,
        period_b_to: periodB.to,
        pubs_a: a.pubs,
        pubs_b: b.pubs,
        cites_a: a.cites,
        cites_b: b.cites,
        label: classifyInsight(a.pubs, b.pubs, a.cites, b.cites),
      };
    })
    .sort(
      (a, b) =>
        a.author_openalex_id.localeCompare(b.author_openalex_id) ||
        a.topic.localeCompare(b.topic),
    );

  writeCsv(
    outTopicLabelsCsvPath,
    [
      "topic",
      "period_a_from",
      "period_a_to",
      "period_b_from",
      "period_b_to",
      "pubs_a",
      "pubs_b",
      "cites_a",
      "cites_b",
      "label",
    ],
    topicLabels,
  );
  writeCsv(
    outAuthorLabelsCsvPath,
    [
      "author_openalex_id",
      "topic",
      "period_a_from",
      "period_a_to",
      "period_b_from",
      "period_b_to",
      "pubs_a",
      "pubs_b",
      "cites_a",
      "cites_b",
      "label",
    ],
    authorLabels,
  );

  console.log(
    "Generated",
    path.relative(ROOT, outPath),
    ",",
    path.relative(ROOT, outTopicCsvPath),
    ",",
    path.relative(ROOT, outAuthorCsvPath),
    ",",
    path.relative(ROOT, outTopicLabelsCsvPath),
    ",",
    path.relative(ROOT, outAuthorLabelsCsvPath),
  );
};

main();
