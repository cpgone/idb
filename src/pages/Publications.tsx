import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpDown,
  Download,
  Linkedin,
  Link as LinkIcon,
  FileText,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SiteShell } from "@/components/SiteShell";
import { worksTable } from "@/data/worksTable.generated";   // <- keep this one
import { filterWorks } from "@/lib/blacklist";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { repairUtf8 } from "@/lib/textRepair";
import { authors } from "@/data/authors.generated";
import dashboardConfigJson from "../../data/config/dashboardConfig.json";
import insightsConfig from "../../data/config/insightsconfig.json";
import siteInfo from "../../data/config/siteinfo.json";
import authorAltNameExclusions from "../../data/config/author-alternate-name-exclusions.json";
import venueTypeOverridesCsv from "../../data/config/venue-type-overrides.csv?raw";
import institutionFiltersConfigJson from "../../data/config/institution-filters.json";
import retractedArticlesConfigJson from "../../data/config/retracted-articles.json";
import { getCitingWorks, type OpenAlexWork } from "@/services/openAlex";

type PublicationSortField =
  | "title"
  | "firstAuthor"
  | "year"
  | "topics"
  | "institutions"
  | "venue"
  | "citations";

type VenueType = "all" | "journal" | "conference" | "other";
type RetractedMode = "exclude" | "include" | "only";
type InstitutionFilterConfig = {
  default?: string;
  options?: Array<{
    id?: string;
    label?: string;
    shortLabel?: string;
    match?: "any" | "all" | string;
    institutions?: string[];
    institutionGroups?: string[][];
  }>;
};
type RetractedArticlesConfig = {
  dois?: string[];
  workIds?: string[];
  excludeDois?: string[];
  excludeWorkIds?: string[];
};
type InstitutionFilterOption = {
  id: string;
  label: string;
  shortLabel?: string;
  match: "any" | "all";
  institutions: string[];
  institutionGroups: string[][];
};

const normalizeVenueType = (value?: string | null): VenueType | null => {
  if (value === "all" || value === "journal" || value === "conference" || value === "other") {
    return value;
  }
  return null;
};

const defaultVenueType =
  normalizeVenueType((siteInfo as { defaultVenueType?: string }).defaultVenueType) ?? "all";
const showInstitutionFilter =
  ((dashboardConfigJson as { showInstitutionFilter?: boolean }).showInstitutionFilter ?? true) !== false;
const institutionFiltersConfig = (institutionFiltersConfigJson as InstitutionFilterConfig) || {};
const defaultInstitutionFilterOptions: InstitutionFilterOption[] = [
  {
    id: "all",
    label: "All institutions",
    shortLabel: "All",
    match: "any",
    institutions: [],
    institutionGroups: [],
  },
];
const retractedArticlesConfig = (retractedArticlesConfigJson as RetractedArticlesConfig) || {};
const conferenceKeywords = [
  "conference",
  "proceedings",
  "symposium",
  "workshop",
  "congress",
  "meeting",
  "annual",
];

const getPublicationSortValue = (field: PublicationSortField, w: (typeof worksTable)[number]) => {
  if (field === "year") {
    if (w.publicationDate) {
      const t = Date.parse(w.publicationDate);
      if (!Number.isNaN(t)) return t;
    }
    return w.year ?? 0;
  }
  if (field === "citations") return w.citations ?? 0;
  if (field === "venue") return (w.venue || "").toLowerCase();
  if (field === "topics") return (w.topics || []).join(", ").toLowerCase();
  if (field === "institutions") return (w.institutions || []).join(", ").toLowerCase();
  if (field === "firstAuthor") {
    const first = (w.allAuthors || [])[0] || "";
    const last =
      w.firstAuthorLastName ||
      (first ? first.split(/\s+/).filter(Boolean).slice(-1)[0] : "");
    return (last || first).toLowerCase();
  }
  const title = (w.title || "").replace(/<[^>]+>/g, " ").trim();
  return title.toLowerCase();
};
const getPublicationTooltip = (w: (typeof worksTable)[number]) => {
  if (!w.publicationDate) return "";
  const t = Date.parse(w.publicationDate);
  if (Number.isNaN(t)) return w.publicationDate;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const defaultYearRangeConfig =
  (insightsConfig as {
    defaultYearRangePages?: { from?: number | null; to?: number | null };
    defaultYearRange?: { from?: number | null; to?: number | null };
  })?.defaultYearRangePages ||
  (insightsConfig as { defaultYearRange?: { from?: number | null; to?: number | null } })
    ?.defaultYearRange ||
  {};

const formatPublicationDate = (w: (typeof worksTable)[number]) => {
  if (w.publicationDate) {
    const t = Date.parse(w.publicationDate);
    if (!Number.isNaN(t)) {
      return new Date(t).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    return w.publicationDate;
  }
  return w.year ? String(w.year) : "";
};

const renderTitleHtml = (title: string | undefined) => (
  <span dangerouslySetInnerHTML={{ __html: title || "" }} />
);

const formatFirstAuthor = (authors: string[] | undefined, firstAuthorLastName?: string) => {
  if (!authors?.length) return "";
  const baseName = firstAuthorLastName || authors[0];
  return authors.length > 1 && baseName ? `${baseName} et al.` : baseName;
};

const isRetractionLikeTitle = (title?: string | null) => {
  const text = (title || "").toLowerCase();
  if (!text) return false;
  return /\bretracted\b|\bretraction\b/.test(text);
};

// Normalize DOIs so duplicates can be detected reliably
const normalizeDoi = (raw?: string | null) => {
  if (!raw) return "";
  let doi = raw.trim().toLowerCase();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  doi = doi.replace(/^doi:/, "");
  return doi.trim();
};

const canonicalOpenAlexWorkId = (raw?: string | null) =>
  (raw || "").replace(/^https?:\/\/(www\.)?openalex\.org\//i, "").trim();

// Normalize names so minor differences (case, hyphen variants, accents)
// don't split the same person into multiple buckets.
const normalizeName = (raw: string) => {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();

  // Unicode normalization: remove diacritics
  s = s.normalize("NFD").replace(/\p{M}+/gu, "");

  // Unify dash / hyphen variants
  s = s.replace(/[\u2010-\u2015]/g, "-");

  // Remove punctuation that shouldn't affect identity
  s = s.replace(/[.,']/g, "");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ");

  return s;
};

const buildExcludedNameSet = (
  openAlexId?: string | null,
  authorId?: string | null,
): Set<string> => {
  const config = authorAltNameExclusions as {
    byOpenAlexId?: Record<
      string,
      | string[]
      | {
          authorName?: string;
          excludeNames?: string[];
        }
    >;
    byAuthorId?: Record<
      string,
      | string[]
      | {
          authorName?: string;
          excludeNames?: string[];
        }
    >;
    global?: string[];
  };
  const excluded = new Set<string>();
  (config.global || []).forEach((n) => {
    if (n) excluded.add(normalizeName(n));
  });
  if (openAlexId) {
    const entry = config.byOpenAlexId?.[openAlexId];
    const list = Array.isArray(entry) ? entry : entry?.excludeNames || [];
    list.forEach((n) => {
      if (n) excluded.add(normalizeName(n));
    });
  }
  if (authorId) {
    const entry = config.byAuthorId?.[authorId];
    const list = Array.isArray(entry) ? entry : entry?.excludeNames || [];
    list.forEach((n) => {
      if (n) excluded.add(normalizeName(n));
    });
  }
  return excluded;
};

const namesRoughlyMatch = (left: string, right: string) => {
  // Repair potential mojibake before normalization
  const cleanInput = (value: string) => repairUtf8(value || "");

  const firstLast = (value: string) => {
    const cleaned = cleanInput(value);
    if (!cleaned) return { first: "", last: "" };
    const hadComma = cleaned.includes(",");
    const norm = normalizeName(cleaned);
    const tokens = norm.split(" ").filter(Boolean);
    if (!tokens.length) return { first: "", last: "" };

    if (hadComma) {
      // Assume "Last, First Middle"
      const commaParts = cleaned.split(",");
      const leftPart = normalizeName(commaParts[0] || "");
      const rightPart = normalizeName(commaParts.slice(1).join(" ") || "");
      const rightTokens = rightPart.split(" ").filter(Boolean);
      const leftTokens = leftPart.split(" ").filter(Boolean);
      const first = rightTokens[0] || tokens[0];
      const last = leftTokens[leftTokens.length - 1] || tokens[tokens.length - 1];
      return { first, last };
    }

    return { first: tokens[0], last: tokens[tokens.length - 1] };
  };

  const a = firstLast(left);
  const b = firstLast(right);
  return !!a.first && !!a.last && a.first === b.first && a.last === b.last;
};

const ALL = "all";
const PAGE_SIZE = 15;
const DEFAULT_RECENT_TOPICS_POOL = 200;

interface PublicationsPageProps {
  mode?: "publications" | "citations";
}

const PublicationsPage = ({ mode = "publications" }: PublicationsPageProps) => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const topicFilter = params.get("topic") || "";
  const institutionFilter = params.get("institution") || "";
  const authorFilter = params.get("author") || "";
  const authorIdFilter = params.get("authorId") || "";
  const coAuthorFilter = params.get("coauthor") || "";
  const venueFilter = params.get("venue") || "";
  const venueTypeParam = params.get("venueType") || "";
  const institutionGroupParam = params.get("institutionGroup") || "";
  const retractedModeParam = params.get("retractedMode") || "";
  const fromYearParam = params.get("fromYear");
  const toYearParam = params.get("toYear");
  const recentTopicsParam = params.get("recentTopics") || "";
  const recentPoolParam = params.get("recentPool");
  const recentTopicsOnly = recentTopicsParam === "1";
  const recentTopicsPool = (() => {
    const value = recentPoolParam ? Number(recentPoolParam) : DEFAULT_RECENT_TOPICS_POOL;
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_RECENT_TOPICS_POOL;
    return Math.floor(value);
  })();
  const [sortBy, setSortBy] = useState<PublicationSortField>(
    mode === "citations" ? "citations" : "year",
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState("");
  const [institutionFilterId, setInstitutionFilterId] = useState<string>("all");
  const [retractedMode, setRetractedMode] = useState<RetractedMode>("exclude");
  const [venueTypeFilter, setVenueTypeFilter] = useState<VenueType>(
    normalizeVenueType(venueTypeParam) ?? defaultVenueType,
  );
  const [citingDialogOpen, setCitingDialogOpen] = useState(false);
  const [selectedCitedWork, setSelectedCitedWork] = useState<(typeof worksTable)[number] | null>(null);
  const [citingPage, setCitingPage] = useState(1);
  const [citingPerPage] = useState(10);
  const [citingTotalCount, setCitingTotalCount] = useState(0);
  const [citingWorks, setCitingWorks] = useState<OpenAlexWork[]>([]);
  const [citingLoading, setCitingLoading] = useState(false);
  const [citingError, setCitingError] = useState<string | null>(null);

  const matchedAuthor = useMemo(() => {
    if (!authorFilter) return null;
    return (
      authors.find((a) => namesRoughlyMatch(a.name, authorFilter)) ||
      null
    );
  }, [authorFilter]);

  const excludedAltNames = useMemo(() => {
    if (!authorFilter && !authorIdFilter) return new Set<string>();
    const openAlexId = matchedAuthor?.openAlexId || authorIdFilter || "";
    const authorId = matchedAuthor?.authorId || "";
    return buildExcludedNameSet(openAlexId, authorId);
  }, [authorFilter, authorIdFilter, matchedAuthor?.openAlexId, matchedAuthor?.authorId]);

  const cleanWorks = useMemo(() => filterWorks(worksTable), []);

  const allYears = useMemo(() => {
    const years = new Set<number>();
    for (const w of cleanWorks) {
      if (w.year && w.year > 0) years.add(w.year);
    }
    return Array.from(years).sort((a, b) => a - b);
  }, [cleanWorks]);

  useEffect(() => {
    const normalized = normalizeVenueType(venueTypeParam);
    if (normalized) {
      setVenueTypeFilter(normalized);
    } else if (!venueTypeParam) {
      setVenueTypeFilter(defaultVenueType);
    }
  }, [venueTypeParam]);

  const institutionFilterOptions = useMemo(() => {
    const rawOptions = Array.isArray(institutionFiltersConfig.options)
      ? institutionFiltersConfig.options
      : [];
    const options = rawOptions
      .map((option) => {
        const id = (option?.id || "").trim();
        const label = (option?.label || "").trim();
        if (!id || !label) return null;
        return {
          id,
          label,
          shortLabel: (option?.shortLabel || "").trim() || undefined,
          match: option?.match === "all" ? "all" : "any",
          institutions: Array.isArray(option?.institutions)
            ? option.institutions.map((name) => (name || "").trim()).filter(Boolean)
            : [],
          institutionGroups: Array.isArray(option?.institutionGroups)
            ? option.institutionGroups
                .map((group) =>
                  Array.isArray(group)
                    ? group.map((name) => (name || "").trim()).filter(Boolean)
                    : [],
                )
                .filter((group) => group.length > 0)
            : [],
        } satisfies InstitutionFilterOption;
      })
      .filter(Boolean) as InstitutionFilterOption[];
    if (!options.length) return defaultInstitutionFilterOptions;
    if (!options.some((option) => option.id === "all")) {
      return [...defaultInstitutionFilterOptions, ...options];
    }
    return options;
  }, []);

  useEffect(() => {
    const defaultFilterId = (institutionFiltersConfig.default || "").trim() || "all";
    const allowed = new Set(institutionFilterOptions.map((option) => option.id));
    const resolved = allowed.has(defaultFilterId) ? defaultFilterId : "all";
    setInstitutionFilterId((prev) => {
      if (allowed.has(prev)) return prev;
      return resolved;
    });
  }, [institutionFilterOptions]);

  useEffect(() => {
    if (!institutionGroupParam) return;
    const allowed = new Set(institutionFilterOptions.map((option) => option.id));
    if (allowed.has(institutionGroupParam)) {
      setInstitutionFilterId(institutionGroupParam);
    }
  }, [institutionGroupParam, institutionFilterOptions]);

  useEffect(() => {
    if (retractedModeParam === "exclude" || retractedModeParam === "include" || retractedModeParam === "only") {
      setRetractedMode(retractedModeParam);
    }
  }, [retractedModeParam]);

  const [startYear, setStartYear] = useState<number | null>(
    fromYearParam ? Number(fromYearParam) : null,
  );
  const [endYear, setEndYear] = useState<number | null>(
    toYearParam ? Number(toYearParam) : null,
  );

  useEffect(() => {
    if (!allYears.length) return;
    const fallbackStart = defaultYearRangeConfig.from ?? allYears[0];
    const fallbackEnd = defaultYearRangeConfig.to ?? allYears[allYears.length - 1];

    setStartYear((prev) => (prev == null ? fallbackStart : prev));
    setEndYear((prev) => (prev == null ? fallbackEnd : prev));
  }, [allYears, defaultYearRangeConfig.from, defaultYearRangeConfig.to]);

  const venueOverrides = useMemo(() => {
    const map = new Map<string, "journal" | "conference" | "other">();
    const splitCsvLine = (line: string) => {
      const match = line.match(/^\s*(?:"([^"]*)"|([^,]*))\s*,\s*(.+)\s*$/);
      if (!match) return null;
      const venue = (match[1] ?? match[2] ?? "").trim();
      const type = match[3]?.trim() ?? "";
      return venue && type ? [venue, type] : null;
    };
    const lines = (venueTypeOverridesCsv || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return map;
    const startIndex = lines[0].toLowerCase().startsWith("venue,") ? 1 : 0;
    for (let i = startIndex; i < lines.length; i += 1) {
      const parsed = splitCsvLine(lines[i]);
      if (!parsed) continue;
      const [venueRaw, typeRaw] = parsed;
      if (!venueRaw || !typeRaw) continue;
      const type = typeRaw.toLowerCase();
      if (type !== "journal" && type !== "conference" && type !== "other") continue;
      map.set(venueRaw.toLowerCase(), type as "journal" | "conference" | "other");
    }
    return map;
  }, []);

  const classifyVenueType = useCallback((venue: string | undefined) => {
    const v = (venue || "").trim().toLowerCase();
    if (!v) return "other" as const;
    const override = venueOverrides.get(v);
    if (override) return override;
    const isConference = conferenceKeywords.some((kw) => v.includes(kw));
    return isConference ? ("conference" as const) : ("journal" as const);
  }, [venueOverrides]);

  const selectedInstitutionFilter = useMemo(() => {
    return institutionFilterOptions.find((option) => option.id === institutionFilterId) || institutionFilterOptions[0];
  }, [institutionFilterOptions, institutionFilterId]);

  const institutionFilterSet = useMemo(
    () =>
      new Set([
        ...(selectedInstitutionFilter?.institutions || []),
        ...((selectedInstitutionFilter?.institutionGroups || []).flatMap((group) => group) || []),
      ].map((name) => name.toLowerCase())),
    [selectedInstitutionFilter],
  );
  const retractedDoiSet = useMemo(
    () =>
      new Set(
        (Array.isArray(retractedArticlesConfig.dois) ? retractedArticlesConfig.dois : [])
          .map((doi) => normalizeDoi(doi))
          .filter(Boolean),
      ),
    [],
  );
  const retractedWorkIdSet = useMemo(
    () =>
      new Set(
        (Array.isArray(retractedArticlesConfig.workIds) ? retractedArticlesConfig.workIds : [])
          .map((id) => (id || "").trim())
          .filter(Boolean),
      ),
    [],
  );
  const excludeRetractedDoiSet = useMemo(
    () =>
      new Set(
        (Array.isArray(retractedArticlesConfig.excludeDois) ? retractedArticlesConfig.excludeDois : [])
          .map((doi) => normalizeDoi(doi))
          .filter(Boolean),
      ),
    [],
  );
  const excludeRetractedWorkIdSet = useMemo(
    () =>
      new Set(
        (Array.isArray(retractedArticlesConfig.excludeWorkIds) ? retractedArticlesConfig.excludeWorkIds : [])
          .map((id) => (id || "").trim())
          .filter(Boolean),
      ),
    [],
  );

  const preTopicFiltered = useMemo(() => {
    const baseWorks = cleanWorks;
    const from = startYear ?? (allYears.length ? allYears[0] : undefined);
    const to = endYear ?? (allYears.length ? allYears[allYears.length - 1] : undefined);

    const query = searchQuery.trim().toLowerCase();
    const seenDois = new Set<string>();

    return baseWorks.filter((w) => {
      const workId = (w.workId || "").trim();
      const doi = normalizeDoi(w.doi);
      const explicitlyExcluded =
        excludeRetractedWorkIdSet.has(workId) || excludeRetractedDoiSet.has(doi);
      const titleLooksRetracted = isRetractionLikeTitle(w.title);
      const isRetracted =
        !explicitlyExcluded &&
        (titleLooksRetracted ||
          retractedWorkIdSet.has(workId) ||
          retractedDoiSet.has(doi));
      if (retractedMode === "exclude" && isRetracted) return false;
      if (retractedMode === "only" && !isRetracted) return false;
      if (!w.year) return false;
      if (from != null && w.year < from) return false;
      if (to != null && w.year > to) return false;
      if (institutionFilter && !(w.institutions || []).includes(institutionFilter))
        return false;
      if (
        selectedInstitutionFilter &&
        selectedInstitutionFilter.id !== "all" &&
        institutionFilterSet.size > 0
      ) {
        const workInstitutionSet = new Set(
          (w.institutions || []).map((institution) => (institution || "").trim().toLowerCase()),
        );
        const groups = selectedInstitutionFilter.institutionGroups || [];
        const matchesInstitutionFilter =
          selectedInstitutionFilter.match === "all"
            ? groups.length > 0
              ? groups.every((group) =>
                  group.some((institution) => workInstitutionSet.has(institution.toLowerCase())),
                )
              : selectedInstitutionFilter.institutions.every((institution) =>
                  workInstitutionSet.has(institution.toLowerCase()),
                )
            : groups.length > 0
              ? groups.some((group) =>
                  group.some((institution) => workInstitutionSet.has(institution.toLowerCase())),
                )
              : selectedInstitutionFilter.institutions.some((institution) =>
                  workInstitutionSet.has(institution.toLowerCase()),
                );
        if (!matchesInstitutionFilter) return false;
      }
      if (
        venueFilter &&
        (w.venue || "").trim().toLowerCase() !== venueFilter.trim().toLowerCase()
      )
        return false;
      const hasAuthorId = authorIdFilter
        ? (w.allAuthorOpenAlexIds || []).includes(authorIdFilter)
        : false;
      const hasAuthorName = authorFilter
        ? (w.allAuthors || []).some((name) => namesRoughlyMatch(name, authorFilter))
        : false;

      if (authorIdFilter) {
        if (!hasAuthorId) return false;
      } else if (authorFilter && !hasAuthorName) {
        return false;
      }
      if (
        coAuthorFilter &&
        !(w.allAuthors || []).some(
          (name) => namesRoughlyMatch(name, coAuthorFilter),
        )
      ) {
        return false;
      }

      if (excludedAltNames.size > 0) {
        const hasExcludedName =
          (w.allAuthors || []).some((name) => excludedAltNames.has(normalizeName(name)));
        const hasMainAuthor = hasAuthorId || hasAuthorName;
        if (hasExcludedName && !hasMainAuthor) return false;
      }

      if (query) {
        const haystack = [
          w.title || "",
          w.venue || "",
          String(w.year ?? ""),
          (w.topics || []).join(" "),
          (w.institutions || []).join(" "),
          (w.allAuthors || []).join(" "), // allow searching by author names
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      // De‑duplicate by normalized DOI
      const doiKey = normalizeDoi(w.doi);
      if (doiKey) {
        if (seenDois.has(doiKey)) return false;
        seenDois.add(doiKey);
      }

      return true;
    });
  }, [
    cleanWorks,
    startYear,
    endYear,
    allYears,
    searchQuery,
    institutionFilter,
    authorFilter,
    authorIdFilter,
    coAuthorFilter,
    venueFilter,
    excludedAltNames,
    selectedInstitutionFilter,
    institutionFilterSet,
    retractedMode,
    retractedDoiSet,
    retractedWorkIdSet,
    excludeRetractedDoiSet,
    excludeRetractedWorkIdSet,
  ]);

  const topicScopedBase = useMemo(() => {
    const source = recentTopicsOnly
      ? [...preTopicFiltered]
          .sort((a, b) => {
            const aDate = a.publicationDate || `${a.year || 0}-01-01`;
            const bDate = b.publicationDate || `${b.year || 0}-01-01`;
            return bDate.localeCompare(aDate);
          })
          .slice(0, Math.min(preTopicFiltered.length, recentTopicsPool))
      : preTopicFiltered;

    if (!topicFilter) return source;
    return source.filter((w) => (w.topics || []).includes(topicFilter));
  }, [preTopicFiltered, recentTopicsOnly, recentTopicsPool, topicFilter]);

  const filtered = useMemo(() => {
    if (venueTypeFilter === "all") return topicScopedBase;
    return topicScopedBase.filter((w) => classifyVenueType(w.venue) === venueTypeFilter);
  }, [topicScopedBase, venueTypeFilter, classifyVenueType]);

  const venueTypeCounts = useMemo(() => {
    const total = topicScopedBase.length;
    let journals = 0;
    let conferences = 0;
    let others = 0;
    topicScopedBase.forEach((w) => {
      const type = classifyVenueType(w.venue);
      if (type === "journal") journals += 1;
      else if (type === "conference") conferences += 1;
      else others += 1;
    });
    return { all: total, journal: journals, conference: conferences, other: others };
  }, [topicScopedBase, classifyVenueType]);


  const sorted = useMemo(() => {
    const items = [...filtered];
    items.sort((a, b) => {
      const dir = sortOrder === "asc" ? 1 : -1;
      const av = getPublicationSortValue(sortBy, a);
      const bv = getPublicationSortValue(sortBy, b);
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
    return items;
  }, [filtered, sortBy, sortOrder]);

  const visibleRows = sorted.slice(0, visibleCount);
  const hasMoreToShow = visibleCount < sorted.length;

  const toggleSort = (field: PublicationSortField) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder(field === "year" || field === "citations" ? "desc" : "asc");
      setVisibleCount(PAGE_SIZE);
    }
  };

  const openCitingDialog = useCallback((work: (typeof worksTable)[number]) => {
    setSelectedCitedWork(work);
    setCitingPage(1);
    setCitingWorks([]);
    setCitingTotalCount(0);
    setCitingError(null);
    setCitingDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!citingDialogOpen || !selectedCitedWork) return;
    const workId = canonicalOpenAlexWorkId(selectedCitedWork.workId);
    if (!workId) {
      setCitingError("This publication does not have a valid OpenAlex work ID.");
      setCitingWorks([]);
      setCitingTotalCount(0);
      return;
    }

    let isActive = true;
    setCitingLoading(true);
    setCitingError(null);

    getCitingWorks(workId, citingPage, citingPerPage)
      .then((result) => {
        if (!isActive) return;
        setCitingWorks(result.results);
        setCitingTotalCount(result.count);
      })
      .catch(() => {
        if (!isActive) return;
        setCitingWorks([]);
        setCitingTotalCount(0);
        setCitingError("Failed to load citing publications from OpenAlex.");
      })
      .finally(() => {
        if (!isActive) return;
        setCitingLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [citingDialogOpen, selectedCitedWork, citingPage, citingPerPage]);

  const title =
    mode === "citations" ? "Publications by citations" : "Publications";

  const handleSavePdf = () => {
    window.print();
  };

  const handleShareLinkedIn = () => {
    const url = window.location.href;
    const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
      url,
    )}`;
    window.open(shareUrl, "_blank", "noopener,noreferrer");
  };

  const handleCopyLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "Publications page URL copied to clipboard.",
      });
    } catch {
      // ignore
    }
  };


  const handleExportCsv = () => {
    if (!sorted.length) return;

    const clean = (value: unknown) => repairUtf8(value ?? "");

    const headers = [
      "title",
      "authors",
      "year",
      "topics",
      "institutions",
      "venue",
      "citations",
      "citation_harvard",
    ];

    const escape = (value: unknown) => {
      const str = clean(value);
      if (str === "") return "";
      const cleaned = str.replace(/\r?\n/g, " ");
      if (/[",]/.test(cleaned)) {
        return `"${cleaned.replace(/"/g, '""')}"`;
      }
      return cleaned;
    };

    const decodeHtmlEntities = (value: string) => {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = value;
      return textarea.value;
    };

    const getExportYear = (w: (typeof worksTable)[number]) => {
      if (w.publicationDate) {
        const d = new Date(w.publicationDate);
        if (!Number.isNaN(d.getTime())) return d.getFullYear();
      }
      return w.year ?? "";
    };

    const formatHarvardCitation = (w: (typeof worksTable)[number]) => {
      const sanitizeText = (value: string) =>
        clean(value)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const authors = (w.allAuthors || []).map((name) => sanitizeText(name));

      const formatInitials = (name: string) =>
        name
          .split(/[\s-]+/)
          .filter(Boolean)
          .map((part) => `${part[0]?.toUpperCase() || ""}.`)
          .join("");

      const formattedAuthors = authors
        .map((fullName) => {
          const parts = fullName.trim().split(/\s+/);
          if (!parts.length) return "";
          const last = parts.pop() || "";
          const initials = formatInitials(parts.join(" "));
          const cleanLast = last.replace(/[,]+/g, "");
          return initials ? `${cleanLast}, ${initials}` : cleanLast;
        })
        .filter(Boolean);

      let authorsPart = "";
      if (formattedAuthors.length === 1) {
        authorsPart = formattedAuthors[0];
      } else if (formattedAuthors.length === 2) {
        authorsPart = `${formattedAuthors[0]} and ${formattedAuthors[1]}`;
      } else if (formattedAuthors.length > 2) {
        authorsPart = `${formattedAuthors.slice(0, -1).join(", ")}, and ${
          formattedAuthors[formattedAuthors.length - 1]
        }`;
      }

      const titlePart = sanitizeText(decodeHtmlEntities(w.title || ""));
      const yearPart = getExportYear(w);
      const venuePart = w.venue ? `${sanitizeText(w.venue)}.` : "";
      const doiPart = w.doi
        ? `doi:${clean(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
        : "";

      return [
        authorsPart ? `${authorsPart},` : "",
        yearPart ? `${yearPart}.` : "",
        titlePart ? `${titlePart}.` : "",
        venuePart,
        doiPart,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    };

    const lines = [headers.join(",")];

    for (const w of sorted) {
      lines.push(
        [
          decodeHtmlEntities(clean(w.title || "")),
          (w.allAuthors || []).map((name) => clean(name)).join("; "),
          getExportYear(w),
          (w.topics || []).map((t) => clean(t)).join("; "),
          (w.institutions || []).map((i) => clean(i)).join("; "),
          clean(w.venue || ""),
          w.citations ?? "",
          formatHarvardCitation({
            ...w,
            title: decodeHtmlEntities(clean(w.title || "")),
          }),
        ]
          .map(escape)
          .join(","),
      );
    }

    // Prepend BOM so Excel consistently opens the file as UTF-8
    const csv = `\uFEFF${lines.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download =
      mode === "citations" ? "publications-by-citations.csv" : "publications.csv";
    a.click();

    URL.revokeObjectURL(url);
  };

  const handleExportCitingCsv = () => {
    if (!citingWorks.length) return;

    const clean = (value: unknown) => repairUtf8(value ?? "");
    const escape = (value: unknown) => {
      const str = clean(value);
      if (str === "") return "";
      const normalized = str.replace(/\r?\n/g, " ");
      if (/[",]/.test(normalized)) {
        return `"${normalized.replace(/"/g, '""')}"`;
      }
      return normalized;
    };

    const headers = ["title", "authors", "year", "venue", "doi", "openalex_work_id", "cited_by_count"];
    const lines = [headers.join(",")];

    for (const work of citingWorks) {
      const authors = (work.authorships || [])
        .map((a) => a?.author?.display_name || "")
        .filter(Boolean)
        .join("; ");
      const doi = (work.doi || "").replace(/^https?:\/\/(www\.)?doi\.org\//i, "").replace(/^doi:/i, "");
      const openAlexId = canonicalOpenAlexWorkId(work.id || "");
      const venue = work.primary_location?.source?.display_name || "";
      lines.push(
        [
          work.title || "",
          authors,
          work.publication_year ?? "",
          venue,
          doi,
          openAlexId,
          work.cited_by_count ?? "",
        ]
          .map(escape)
          .join(","),
      );
    }

    const csv = `\uFEFF${lines.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `citing-publications-page-${citingPage}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SiteShell>
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => navigate("/")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to dashboard
          </Button>
          <Button
            variant="ghost"
            onClick={() => navigate(-1)}
            className="px-2 text-xs"
          >
            Back to previous
          </Button>
        </div>

        <Card className="border-border/60">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <CardTitle>{title}</CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSavePdf}
                  title="Save PDF"
                >
                  <Download className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleExportCsv}
                  title="Export CSV"
                >
                  <FileText className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleShareLinkedIn}
                  title="Share on LinkedIn"
                >
                  <Linkedin className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleCopyLink}
                  title="Copy link"
                >
                  <LinkIcon className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[260px] flex-1 max-w-xl">
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  placeholder="Search title, venue, topic..."
                  className="h-8 pl-7 pr-2 text-xs"
                />
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Publication type:</span>
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-xs"
                  value={venueTypeFilter}
                  onChange={(e) => {
                    setVenueTypeFilter(e.target.value as VenueType);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  <option value="all">All ({venueTypeCounts.all})</option>
                  <option value="journal">Journals ({venueTypeCounts.journal})</option>
                  <option value="conference">Conferences ({venueTypeCounts.conference})</option>
                  <option value="other">Others ({venueTypeCounts.other})</option>
                </select>
              </div>
              {showInstitutionFilter && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Institution:</span>
                  <select
                    className="h-8 rounded border border-border bg-background px-2 text-xs"
                    value={institutionFilterId}
                    onChange={(e) => {
                      setInstitutionFilterId(e.target.value);
                      setVisibleCount(PAGE_SIZE);
                    }}
                  >
                    {institutionFilterOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.shortLabel || option.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Retracted:</span>
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-xs"
                  value={retractedMode}
                  onChange={(e) => {
                    setRetractedMode(e.target.value as RetractedMode);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  <option value="exclude">Exclude retracted</option>
                  <option value="include">Include retracted</option>
                  <option value="only">Only retracted</option>
                </select>
              </div>
              {allYears.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Year range:</span>
                  <select
                    className="h-8 rounded border border-border bg-background px-2 text-xs"
                    value={startYear ?? ""}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setStartYear(value);
                      if (endYear != null && value > endYear) setEndYear(value);
                    }}
                  >
                    {allYears.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                  <span>to</span>
                  <select
                    className="h-8 rounded border border-border bg-background px-2 text-xs"
                    value={endYear ?? ""}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setEndYear(value);
                      if (startYear != null && value < startYear) setStartYear(value);
                    }}
                  >
                    {allYears.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </CardHeader>

          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <div />
              <span>
                Showing {visibleRows.length} of {sorted.length} publications
              </span>
            </div>

            {sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No publications match the selected filters.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="mb-2" />

                <div className="overflow-x-auto rounded-md border border-border/60 bg-card/40">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("title")}
                          >
                            <FileText className="h-3 w-3 text-primary" />
                            Title
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("firstAuthor")}
                          >
                            First author
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell text-right">
                          <button
                            type="button"
                            className="flex w-full items-center justify-end gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("year")}
                          >
                            Date
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden lg:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("topics")}
                          >
                            Topics
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden lg:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("institutions")}
                          >
                            Institutions
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("venue")}
                          >
                            Venue
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell text-right">
                          <button
                            type="button"
                            className="flex w-full items-center justify-end gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground border-0 focus-visible:outline-none"
                            onClick={() => toggleSort("citations")}
                          >
                            Citations
                            <ArrowUpDown className="h-3 w-3" />
                          </button>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRows.map((w) => {

                        const doiUrl = (() => {
                          const rawDoi = (w.doi || "").trim();
                          if (!rawDoi) return "";
                          const cleaned = rawDoi
                            .replace(/^https?:\/\/(www\.)?doi\.org\//i, "")
                            .replace(/^doi:/i, "")
                            .trim();
                          return cleaned ? `https://doi.org/${cleaned}` : "";
                        })();

                        const displayDate = formatPublicationDate(w);

                        return (
                          <TableRow key={w.workId}>
                            <TableCell className="align-top text-foreground">
                              <div className="flex flex-col gap-1">
                                {doiUrl ? (
                                  <a
                                    href={doiUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-medium text-primary hover:underline"
                                  >
                                    {renderTitleHtml(w.title)}
                                  </a>
                                ) : (
                                  <span className="font-medium">
                                    {renderTitleHtml(w.title)}
                                  </span>
                                )}

                                {/* Compact line for mobile */}
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground md:hidden">
                                  {w.venue && (
                                    <span className="font-semibold text-foreground">
                                      {w.venue}
                                    </span>
                                  )}

                                  {w.allAuthors && w.allAuthors.length > 0 ? (
                                    <>
                                      <span>•</span>
                                      <span>{formatFirstAuthor(w.allAuthors, w.firstAuthorLastName)}</span>
                                    </>
                                  ) : (
                                    <>
                                      <span>•</span>
                                      <span>Authors n/a</span>
                                    </>
                                  )}

                                  {displayDate && (
                                    <>
                                      <span>•</span>
                                      <span>{displayDate}</span>
                                    </>
                                  )}

                                  {typeof w.citations === "number" && w.citations > 0 && (
                                    <>
                                      <span>•</span>
                                      <button
                                        type="button"
                                        className="text-primary hover:underline"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          openCitingDialog(w);
                                        }}
                                        title="Show citing publications"
                                      >
                                        {w.citations} citations
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </TableCell>

                            {/* Desktop-only cells */}
                            <TableCell className="hidden md:table-cell text-muted-foreground">
                              {w.allAuthors && w.allAuthors.length > 0 ? (
                                <span
                                  title={w.allAuthors.join(", ")}
                                  className="cursor-default"
                                >
                                  {formatFirstAuthor(w.allAuthors, w.firstAuthorLastName)}
                                </span>
                              ) : (
                                ""
                              )}
                            </TableCell>

                            <TableCell
                              className="hidden md:table-cell text-right text-muted-foreground"
                              title={getPublicationTooltip(w)}
                            >
                              {displayDate}
                            </TableCell>

                            <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                              {(w.topics || []).join(", ")}
                            </TableCell>

                                                        <TableCell
                              className="hidden lg:table-cell text-xs text-muted-foreground"
                              title={(w.institutions || []).join(", ")}
                            >
                              {(() => {
                                const institutions = w.institutions || [];
                                const maxToShow = 2;
                                const shown = institutions.slice(0, maxToShow);
                                const remaining = institutions.length - shown.length;

                                return (
                                  <>
                                    {shown.join(", ")}
                                    {remaining > 0 && (
                                      <span className="text-muted-foreground/80">
                                        {shown.length ? ", " : ""}
                                        +{remaining} more
                                      </span>
                                    )}
                                  </>
                                );
                              })()}
                            </TableCell>


                            <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                              {w.venue}
                            </TableCell>

                            <TableCell className="hidden md:table-cell text-right">
                              {(w.citations ?? 0) > 0 ? (
                                <button
                                  type="button"
                                  className="text-primary hover:underline"
                                  onClick={() => openCitingDialog(w)}
                                  title="Show citing publications"
                                >
                                  {w.citations ?? 0}
                                </button>
                              ) : (
                                w.citations ?? 0
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {hasMoreToShow && (
                  <div className="flex justify-center gap-2 pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setVisibleCount((count) =>
                          Math.min(count + PAGE_SIZE, sorted.length),
                        )
                      }
                    >
                      Load more
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setVisibleCount(sorted.length)}
                    >
                      Load all
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>



        </Card>

        <Dialog open={citingDialogOpen} onOpenChange={setCitingDialogOpen}>
          <DialogContent className="w-[calc(100vw-1rem)] max-w-3xl max-h-[92dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Who cited this paper?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {selectedCitedWork ? (
                <div className="rounded-md border border-border/60 bg-card/40 p-3 text-sm">
                  <div className="font-semibold text-foreground">
                    {selectedCitedWork.title || "Untitled"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {(selectedCitedWork.citations ?? 0).toLocaleString()} total citations in dataset
                  </div>
                </div>
              ) : null}

              {citingLoading ? (
                <div className="text-sm text-muted-foreground">Loading citing publications...</div>
              ) : citingError ? (
                <div className="text-sm text-destructive">{citingError}</div>
              ) : citingWorks.length === 0 ? (
                <div className="text-sm text-muted-foreground">No citing publications found.</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      Showing page {citingPage} of {Math.max(1, Math.ceil(citingTotalCount / citingPerPage))} ({citingTotalCount.toLocaleString()} total)
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleExportCitingCsv}
                      disabled={citingLoading || citingWorks.length === 0}
                      title="Export citing publications (current page)"
                    >
                      <FileText className="mr-1 h-3.5 w-3.5" />
                      Export CSV
                    </Button>
                  </div>
                  <div className="max-h-[45dvh] sm:max-h-[420px] space-y-2 overflow-y-auto pr-1">
                    {citingWorks.map((work) => {
                      const authorsLabel = (work.authorships || [])
                        .map((a) => a?.author?.display_name)
                        .filter(Boolean)
                        .slice(0, 6)
                        .join(", ");
                      const venueLabel = work.primary_location?.source?.display_name || "";
                      const doiLabel = (work.doi || "").replace(/^https?:\/\/(www\.)?doi\.org\//i, "");
                      const cleanDoi = doiLabel.replace(/^doi:/i, "").trim();
                      const workUrl = cleanDoi
                        ? `https://doi.org/${cleanDoi}`
                        : work.id
                          ? `https://openalex.org/${canonicalOpenAlexWorkId(work.id)}`
                          : "";
                      return (
                        <div key={work.id} className="rounded-md border border-border/60 bg-card/40 p-3">
                          <a
                            href={workUrl || undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-semibold text-primary hover:underline"
                          >
                            {work.title || "Untitled"}
                          </a>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {work.publication_year || "Year n/a"}
                            {venueLabel ? ` • ${venueLabel}` : ""}
                            {doiLabel ? ` • doi:${doiLabel}` : ""}
                          </div>
                          {authorsLabel ? (
                            <div className="mt-1 text-xs text-muted-foreground">{authorsLabel}</div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCitingPage((p) => Math.max(1, p - 1))}
                      disabled={citingPage <= 1 || citingLoading}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCitingPage((p) =>
                          Math.min(Math.max(1, Math.ceil(citingTotalCount / citingPerPage)), p + 1),
                        )
                      }
                      disabled={citingLoading || citingPage >= Math.max(1, Math.ceil(citingTotalCount / citingPerPage))}
                    >
                      Next
                    </Button>
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>

      </main>
    </SiteShell>
  );
};

export default PublicationsPage;
