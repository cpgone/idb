import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * OpenAlex ids sometimes come as full URLs. Extract the trailing id segment
 * so comparisons stay consistent everywhere.
 */
export const normalizeOpenAlexId = (raw?: string | null) => {
  if (!raw) return "";

  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

type WorkLike = {
  workId?: string | null;
  doi?: string | null;
  title?: string | null;
  year?: number | null;
};

const normalizeDoi = (raw?: string | null) =>
  (raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "")
    .trim();

const normalizeTitle = (raw?: string | null) => {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Build a stable key for a work so we can deduplicate rows that describe the
 * same OpenAlex record (for example, when multiple programs include it).
 */
export const makeWorkKey = (work?: WorkLike) => {
  if (!work) return "";
  const workId = work.workId?.trim();
  if (workId) return workId.toLowerCase();

  const doi = work.doi?.trim();
  if (doi) return doi.toLowerCase();

  const title = work.title?.trim().toLowerCase() || "";
  const year = work.year ?? "";
  if (title || year) return `${title}|${year}`;

  return "";
};

/**
 * Prefer records that have a DOI when the title+year match. Drops empty-DOI
 * duplicates but preserves order otherwise.
 */
export const dedupePreferDoiTitleYear = <T extends WorkLike>(works: T[]) => {
  const keyToIndex = new Map<string, number>();
  const result: T[] = [];

  works.forEach((work) => {
    const doiKey = normalizeDoi(work.doi);
    const titleKey = normalizeTitle(work.title);
    const yearKey = typeof work.year === "number" ? String(work.year) : "";
    const titleYearKey = titleKey && yearKey ? `ty:${titleKey}|${yearKey}` : "";

    const lookupKeys = [doiKey && `doi:${doiKey}`, titleYearKey].filter(Boolean) as string[];
    let existingIdx = -1;
    for (const k of lookupKeys) {
      const idx = keyToIndex.get(k);
      if (idx != null) {
        existingIdx = idx;
        break;
      }
    }

    if (existingIdx === -1) {
      const idx = result.length;
      result.push(work);
      lookupKeys.forEach((k) => keyToIndex.set(k, idx));
      return;
    }

    const current = result[existingIdx];
    const currentHasDoi = normalizeDoi(current.doi).length > 0;
    const candidateHasDoi = doiKey.length > 0;

    if (candidateHasDoi && !currentHasDoi) {
      result[existingIdx] = work;
      lookupKeys.forEach((k) => keyToIndex.set(k, existingIdx));
    }
  });

  return result;
};

/**
 * Remove duplicate works while preserving order. Useful when the same work is
 * emitted once per program but we only want to count it once per author.
 */
export const dedupeWorks = <T extends WorkLike>(works: T[]) => {
  const seen = new Set<string>();
  const result: T[] = [];

  works.forEach((work, index) => {
    const key = makeWorkKey(work);
    const dedupeKey = key || `__unknown_${index}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    result.push(work);
  });

  return result;
};
