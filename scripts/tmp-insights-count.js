const fs = require('fs');
const path = require('path');
const root = 'd:/GitHub/CPGOne.com/idb3';

const worksText = fs.readFileSync(path.join(root, 'src/data/worksTable.generated.ts'), 'utf8');
const start = worksText.indexOf('export const worksTable');
if (start < 0) throw new Error('worksTable not found');
const arrStart = worksText.indexOf('[', start);
const arrEnd = worksText.lastIndexOf('\n];');
if (arrStart < 0 || arrEnd < 0) throw new Error('array bounds not found');
const jsonText = worksText.slice(arrStart, arrEnd + 2);
let works;
try {
  works = JSON.parse(jsonText);
} catch (e) {
  console.error('JSON parse failed', e.message);
  process.exit(1);
}

const blacklistCsv = fs.readFileSync(path.join(root, 'data/config/blacklist.csv'), 'utf8');
const lines = blacklistCsv
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const entries = [];
if (lines.length > 1) {
  const unquote = (s) => s.replace(/^"(.*)"$/, '$1');
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < 5) continue;
    const [scopeRaw, authorId, workId, doi, titleSlug] = cols.map(unquote);
    const scope = scopeRaw === 'per-author' ? 'per-author' : 'global';
    entries.push({
      scope,
      authorId: authorId?.trim().toLowerCase() || undefined,
      workId: workId || undefined,
      doi: doi || undefined,
      titleSlug: titleSlug?.trim().toLowerCase() || undefined,
    });
  }
}

const normalizeId = (value) => (value || '').trim().toLowerCase();
const canonicalWorkId = (value) =>
  normalizeId(value).replace(/^https?:\/\/(www\.)?openalex\.org\//, '');
const canonicalDoi = (value) =>
  normalizeId(value)
    .replace(/^https?:\/\/(www\.)?doi\.org\//, '')
    .replace(/^doi:/, '');
const slugify = (raw) => {
  if (!raw) return '';
  let s = raw.trim().toLowerCase();
  s = s.normalize('NFD').replace(/\p{M}+/gu, '');
  s = s.replace(/[\u2010-\u2015]/g, '-');
  s = s.replace(/[^\w\s-]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  s = s.trim().replace(/\s+/g, '-');
  return s;
};

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
  if (entry.scope === 'global') {
    if (entry.workId) globalIds.add(canonicalWorkId(entry.workId));
    if (entry.doi) globalDois.add(canonicalDoi(entry.doi));
    if (entry.titleSlug) globalSlugs.add(entry.titleSlug);
  } else if (entry.scope === 'per-author' && entry.authorId) {
    const authorKey = normalizeId(entry.authorId);
    if (entry.workId) addToMap(perAuthorIds, authorKey, canonicalWorkId(entry.workId));
    if (entry.doi) addToMap(perAuthorDois, authorKey, canonicalDoi(entry.doi));
    if (entry.titleSlug) addToMap(perAuthorSlugs, authorKey, entry.titleSlug);
  }
}

const normalizeWorkId = (work) => canonicalWorkId(work.workId);
const normalizeDoiValue = (work) => canonicalDoi(work.doi);
const workSlug = (work) => slugify(`${work.title || ''} ${work.year != null ? work.year : ''}`);

const isBlacklisted = (work, authorId) => {
  const id = normalizeWorkId(work);
  const doi = normalizeDoiValue(work);
  const slug = normalizeId(workSlug(work));

  if (id && globalIds.has(id)) return true;
  if (doi && globalDois.has(doi)) return true;
  if (slug && globalSlugs.has(slug)) return true;

  const authorKey = normalizeId(authorId);
  if (authorKey) {
    if (id && (perAuthorIds.get(authorKey)?.has(id) ?? false)) return true;
    if (doi && (perAuthorDois.get(authorKey)?.has(doi) ?? false)) return true;
    if (slug && (perAuthorSlugs.get(authorKey)?.has(slug) ?? false)) return true;
  }

  return false;
};

const cleanWorks = works.filter((w) => !isBlacklisted(w));
const years = [...new Set(cleanWorks.map((w) => w.year).filter((y) => typeof y === 'number'))].sort(
  (a, b) => a - b,
);
const min = years[0];
const max = years[years.length - 1];

const insightsConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'data/config/insightsconfig.json'), 'utf8'),
);
const clamp = (value) => {
  if (value == null || Number.isNaN(value)) return null;
  return Math.min(Math.max(value, min), max);
};

const defaultsA = insightsConfig?.insightsDefaultPeriodA || {};
const defaultsB = insightsConfig?.insightsDefaultPeriodB || {};

let aFrom = clamp(defaultsA.from) ?? min;
let aTo = clamp(defaultsA.to) ?? max;
if (aFrom > aTo) [aFrom, aTo] = [aTo, aFrom];

let bFrom = clamp(defaultsB.from) ?? min;
let bTo = clamp(defaultsB.to) ?? max;
if (bFrom > bTo) [bFrom, bTo] = [bTo, bFrom];

const buildAggregates = (works, from, to) => {
  const map = new Map();
  for (const work of works) {
    if (typeof work.year !== 'number') continue;
    if (work.year < from || work.year > to) continue;
    (work.topics || []).forEach((topic) => {
      if (!topic) return;
      const current = map.get(topic) || { pubs: 0, cites: 0 };
      current.pubs += 1;
      current.cites += work.citations || 0;
      map.set(topic, current);
    });
  }
  return map;
};

const aggA = buildAggregates(cleanWorks, aFrom, aTo);
const aggB = buildAggregates(cleanWorks, bFrom, bTo);
const topics = new Set([...aggA.keys(), ...aggB.keys()]);

const deriveInsight = (pubsA, pubsB, citesA, citesB) => {
  const pubsRatio = pubsA === 0 ? (pubsB > 0 ? Infinity : 0) : pubsB / pubsA;
  const citesRatio = citesA === 0 ? (citesB > 0 ? Infinity : 0) : citesB / citesA;

  if (pubsA === 0 && pubsB > 0) return 'Emerging';
  if (pubsB === 0) return 'Declining';
  if (pubsRatio < 0.8 || citesRatio < 0.8) return 'Declining';
  if (pubsRatio >= 2 && citesRatio >= 2) return 'Strong surge';
  if (pubsRatio >= 1 && citesRatio >= 1) return 'Growing priority';
  if (pubsRatio >= 1 && citesRatio < 1) return 'Output rising, impact softening';
  if (citesRatio >= 1 && pubsRatio < 1) return 'Impact-led';
  return 'Stable';
};

const counts = {
  emerging: 0,
  declining: 0,
  strongSurge: 0,
  growingPriority: 0,
  impactLed: 0,
  outputSoftening: 0,
  stable: 0,
};

for (const topic of topics) {
  const a = aggA.get(topic) || { pubs: 0, cites: 0 };
  const b = aggB.get(topic) || { pubs: 0, cites: 0 };
  const insight = deriveInsight(a.pubs, b.pubs, a.cites, b.cites);
  if (insight === 'Emerging') counts.emerging += 1;
  else if (insight === 'Declining') counts.declining += 1;
  else if (insight === 'Strong surge') counts.strongSurge += 1;
  else if (insight === 'Growing priority') counts.growingPriority += 1;
  else if (insight === 'Impact-led') counts.impactLed += 1;
  else if (insight === 'Output rising, impact softening') counts.outputSoftening += 1;
  else if (insight === 'Stable') counts.stable += 1;
}

const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
console.log(
  JSON.stringify(
    {
      counts,
      total,
      periodA: { from: aFrom, to: aTo },
      periodB: { from: bFrom, to: bTo },
    },
    null,
    2,
  ),
);
