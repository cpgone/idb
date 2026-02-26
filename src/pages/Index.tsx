import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatCard } from "@/components/StatCard";
import {
  TrendingUp,
  TrendingDown,
  Users,
  FileText,
  User,
  ArrowUpRight,
  Download,
  Sparkles,
  Target,
  Activity,
  Minus,
} from "lucide-react";
import { authors } from "@/data/authors.generated";
import { useNavigate } from "react-router-dom";
import { SiteShell } from "@/components/SiteShell";
import { worksTable } from "@/data/worksTable.generated";
import { workCitationTrendByWorkId } from "@/data/workCitationTrend.generated";
import { filterWorks } from "@/lib/blacklist";
import { dedupePreferDoiTitleYear } from "@/lib/utils";
import dashboardConfigJson from "../../data/config/dashboardConfig.json";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import insightsConfig from "../../data/config/insightsconfig.json";
import venueTypeOverridesCsv from "../../data/config/venue-type-overrides.csv?raw";
import institutionFiltersConfigJson from "../../data/config/institution-filters.json";
import recentCitationsJson from "../../data/recent-citations.json";
import { topicYearStats } from "@/data/insightsAggregates.generated";
import { getCitingWorks, type OpenAlexWork } from "@/services/openAlex";
import {
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const parseHslString = (value: string) => {
  const parts = value.trim().replace(/,/g, " ").split(/\s+/);
  if (parts.length < 3) return null;
  const h = Number(parts[0]);
  const s = Number(parts[1].replace("%", ""));
  const l = Number(parts[2].replace("%", ""));
  if ([h, s, l].some((v) => Number.isNaN(v))) return null;
  return { h, s, l };
};

const hslToHex = (h: number, s: number, l: number) => {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h >= 0 && h < 60) [r, g, b] = [c, x, 0];
  else if (h >= 60 && h < 120) [r, g, b] = [x, c, 0];
  else if (h >= 120 && h < 180) [r, g, b] = [0, c, x];
  else if (h >= 180 && h < 240) [r, g, b] = [0, x, c];
  else if (h >= 240 && h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const canonicalOpenAlexWorkId = (raw?: string | null) =>
  (raw || "").replace(/^https?:\/\/(www\.)?openalex\.org\//i, "").trim();
const renderWorkTitleHtml = (title: string | undefined) => (
  <span dangerouslySetInnerHTML={{ __html: title || "" }} />
);

const compactStatFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const SimpleTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload as { label?: string } | undefined;
  const label = data?.label ?? payload[0]?.name ?? "";
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-sm">
      <div className="font-semibold mb-1">{label}</div>
      {payload.map((entry) => {
        const name = entry.name ?? "";
        const value = entry.value;
        if (value == null) return null;
        const display = typeof value === "number" ? value.toLocaleString() : String(value);
        return (
          <div key={name} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: entry.color }} />
            <span>{name}:</span>
            <span className="font-semibold">{display}</span>
          </div>
        );
      })}
    </div>
  );
};

type DashboardConfig = {
  showStats: boolean;
  showCharts: boolean;
  defaultYearRange?: { from?: number | null; to?: number | null };
  defaultYearRangeCharts?: { from?: number | null; to?: number | null };
  defaultPublicationType?: VenueType;
  defaultInstitutionFilterId?: string;
  recentCitationsWindowDays?: number;
  mainPageDefaults?: {
    yearRange?: { from?: number | null; to?: number | null };
    publicationType?: VenueType;
    institutionFilterId?: string;
  };
  statCards: {
    members: boolean;
    topics: boolean;
    insights: boolean;
    institutions: boolean;
    publications: boolean;
    citations: boolean;
  };
};

type VenueType = "all" | "journal" | "conference" | "other";
type RecentPublicationMode = "published" | "published_cited";
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
type InstitutionFilterOption = {
  id: string;
  label: string;
  shortLabel?: string;
  match: "any" | "all";
  institutions: string[];
  institutionGroups: string[][];
};
type RecentCitationFeedItem = {
  workId?: string;
  doi?: string;
  title?: string;
  venue?: string;
  publicationDate?: string;
  year?: number;
  allAuthors?: string[];
  addedAt?: string;
  citationAddedAt?: string;
  citedByCount?: number;
};

type WorkWithAddedAt = (typeof worksTable)[number] & { addedAt?: string | null; citedByCount?: number };
const conferenceKeywords = [
  "conference",
  "proceedings",
  "symposium",
  "workshop",
  "congress",
  "meeting",
  "annual",
];

const classifyVenueType = (
  venue: string | undefined,
  venueOverrides: Map<string, "journal" | "conference" | "other">,
): Exclude<VenueType, "all"> => {
  const v = (venue || "").trim().toLowerCase();
  if (!v) return "other";
  const override = venueOverrides.get(v);
  if (override) return override;
  const isConference = conferenceKeywords.some((kw) => v.includes(kw));
  return isConference ? "conference" : "journal";
};

const dashboardConfig = (dashboardConfigJson as DashboardConfig) || {
  showStats: true,
  showCharts: true,
  showInstitutionFilter: true,
  recentCitationsWindowDays: 7,
  statCards: {
    members: true,
    topics: true,
    insights: true,
    institutions: true,
    publications: true,
    citations: true,
  },
};
const mainPageDefaults = dashboardConfig.mainPageDefaults || {};
const showInstitutionFilter = dashboardConfig.showInstitutionFilter !== false;
const recentCitationsWindowDays =
  typeof dashboardConfig.recentCitationsWindowDays === "number" && dashboardConfig.recentCitationsWindowDays > 0
    ? Math.min(90, Math.max(1, Math.floor(dashboardConfig.recentCitationsWindowDays)))
    : 7;
const defaultYearRangeConfig =
  mainPageDefaults.yearRange ||
  dashboardConfig.defaultYearRangeCharts ||
  dashboardConfig.defaultYearRange ||
  {};
const defaultPublicationType: VenueType =
  mainPageDefaults.publicationType === "journal" ||
  mainPageDefaults.publicationType === "conference" ||
  mainPageDefaults.publicationType === "other"
    ? mainPageDefaults.publicationType
    : dashboardConfig.defaultPublicationType === "journal" ||
        dashboardConfig.defaultPublicationType === "conference" ||
        dashboardConfig.defaultPublicationType === "other"
      ? dashboardConfig.defaultPublicationType
    : "all";
const defaultInstitutionFilterId = (dashboardConfig.defaultInstitutionFilterId || "").trim() || "all";
const resolvedDefaultInstitutionFilterId =
  (mainPageDefaults.institutionFilterId || "").trim() || defaultInstitutionFilterId;
const defaultInsightsPeriodB =
  (insightsConfig as { insightsDefaultPeriodB?: { from?: number | null; to?: number | null } })
    ?.insightsDefaultPeriodB || {};
const configuredInsightsBoundaryYear = defaultInsightsPeriodB.from ?? null;
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
const recentCitationFeed: RecentCitationFeedItem[] = Array.isArray(recentCitationsJson)
  ? (recentCitationsJson as RecentCitationFeedItem[])
  : [];

const deriveInsight = (pubsA: number, pubsB: number, citesA: number, citesB: number) => {
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

const buildAggregatesFromWorks = (
  works: (typeof worksTable)[number][],
  from: number,
  to: number,
) => {
  if (from > to) return new Map<string, { pubs: number; cites: number }>();
  const map = new Map<string, { pubs: number; cites: number }>();
  works.forEach((work) => {
    if (typeof work.year !== "number") return;
    if (work.year < from || work.year > to) return;
    (work.topics || []).forEach((topic) => {
      if (!topic) return;
      const current = map.get(topic) || { pubs: 0, cites: 0 };
      current.pubs += 1;
      current.cites += work.citations || 0;
      map.set(topic, current);
    });
  });
  return map;
};

const buildAggregatesFromStats = (from: number, to: number) => {
  if (from > to) return new Map<string, { pubs: number; cites: number }>();
  const map = new Map<string, { pubs: number; cites: number }>();
  topicYearStats.forEach((row) => {
    if (row.year < from || row.year > to) return;
    const current = map.get(row.topic) || { pubs: 0, cites: 0 };
    current.pubs += row.pubs;
    current.cites += row.cites;
    map.set(row.topic, current);
  });
  return map;
};

const Index = () => {
  const navigate = useNavigate();
  const INITIAL_PUBLICATIONS_LIMIT = 7;
  const INITIAL_CITED_LIMIT = 7;
  const INITIAL_TOPICS_LIMIT = 20;
  const RECENT_TOPICS_POOL_SIZE = 200;
  const PUBLICATIONS_STEP = 6;
  const CITED_STEP = 6;
  const TOPICS_STEP = 10;

  const memberCount = authors.length;
  const cleanWorks = useMemo(() => dedupePreferDoiTitleYear(filterWorks(worksTable)), []);
  const hasTopicYearStats = topicYearStats.length > 0;

  const allYears = useMemo(() => {
    const years = new Set<number>();
    cleanWorks.forEach((w) => {
      if (typeof w.year === "number") years.add(w.year);
    });
    return Array.from(years).sort((a, b) => a - b);
  }, [cleanWorks]);

  const [startYear, setStartYear] = useState<number | null>(null);
  const [endYear, setEndYear] = useState<number | null>(null);
  const [institutionFilterId, setInstitutionFilterId] = useState<string>(resolvedDefaultInstitutionFilterId);
  const [venueTypeFilter, setVenueTypeFilter] = useState<VenueType>(defaultPublicationType);
  const [recentPublicationMode, setRecentPublicationMode] =
    useState<RecentPublicationMode>("published");
  const [publicationLimit, setPublicationLimit] = useState<number>(INITIAL_PUBLICATIONS_LIMIT);
  const [citedLimit, setCitedLimit] = useState<number>(INITIAL_CITED_LIMIT);
  const [topicLimit, setTopicLimit] = useState<number>(INITIAL_TOPICS_LIMIT);
  const [showTopics, setShowTopics] = useState(true);
  const [showPublications, setShowPublications] = useState(true);
  const [showCitations, setShowCitations] = useState(false);
  const [showInstitutions, setShowInstitutions] = useState(false);
  const [showCoAuthors, setShowCoAuthors] = useState(false);
  const [expandedAuthors, setExpandedAuthors] = useState<Set<string>>(new Set());
  const [chartSeriesColors, setChartSeriesColors] = useState({
    topics: "#22c55e",
    institutions: "#0ea5e9",
    publications: "#7c3aed",
    citations: "#f97316",
    coAuthors: "#f59e0b",
  });
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [selectedCitedWork, setSelectedCitedWork] = useState<(typeof worksTable)[number] | null>(null);
  const [citingDialogOpen, setCitingDialogOpen] = useState(false);
  const [citingPage, setCitingPage] = useState(1);
  const [citingPerPage] = useState(10);
  const [citingTotalCount, setCitingTotalCount] = useState(0);
  const [citingWorks, setCitingWorks] = useState<OpenAlexWork[]>([]);
  const [citingLoading, setCitingLoading] = useState(false);
  const [citingError, setCitingError] = useState<string | null>(null);
  const [activeInsightIndex, setActiveInsightIndex] = useState(0);
  const [pauseInsightRotation, setPauseInsightRotation] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);

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
    const configuredDefault =
      resolvedDefaultInstitutionFilterId || (institutionFiltersConfig.default || "").trim() || "all";
    const normalizedDefault = configuredDefault.toLowerCase();
    const matchedOption = institutionFilterOptions.find((option) => {
      const id = option.id.toLowerCase();
      const shortLabel = (option.shortLabel || "").toLowerCase();
      const label = option.label.toLowerCase();
      return (
        id === normalizedDefault ||
        shortLabel === normalizedDefault ||
        label === normalizedDefault
      );
    });
    const allowed = new Set(institutionFilterOptions.map((option) => option.id));
    const resolved = matchedOption?.id || (allowed.has(configuredDefault) ? configuredDefault : "all");
    setInstitutionFilterId((prev) => {
      if (allowed.has(prev)) return prev;
      return resolved;
    });
  }, [institutionFilterOptions, resolvedDefaultInstitutionFilterId]);

  useEffect(() => {
    if (!allYears.length) return;
    const minYear = allYears[0];
    const maxYear = allYears[allYears.length - 1];

    const clamp = (value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return null;
      return Math.min(Math.max(value, minYear), maxYear);
    };

    const configuredFrom = clamp(defaultYearRangeConfig.from) ?? minYear;
    const configuredTo = clamp(defaultYearRangeConfig.to) ?? maxYear;
    const [resolvedStart, resolvedEnd] =
      configuredFrom <= configuredTo ? [configuredFrom, configuredTo] : [minYear, maxYear];

    setStartYear((prev) => {
      if (prev == null) return resolvedStart;
      const clamped = clamp(prev);
      return clamped ?? resolvedStart;
    });
    setEndYear((prev) => {
      if (prev == null) return resolvedEnd;
      const clamped = clamp(prev);
      return clamped ?? resolvedEnd;
    });
  }, [allYears, defaultYearRangeConfig.from, defaultYearRangeConfig.to]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolveColor = (varName: string, fallback: string) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
      const parsed = raw ? parseHslString(raw) : null;
      return parsed ? hslToHex(parsed.h, parsed.s, parsed.l) : fallback;
    };
    const updateColors = () => {
      setChartSeriesColors({
        topics: resolveColor("--chart-1", "#22c55e"),
        institutions: resolveColor("--chart-2", "#0ea5e9"),
        publications: resolveColor("--chart-3", "#7c3aed"),
        citations: resolveColor("--chart-4", "#f97316"),
        coAuthors: resolveColor("--chart-5", "#f59e0b"),
      });
    };
    updateColors();
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, []);

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

  const institutionFilteredWorks = useMemo(() => {
    if (!selectedInstitutionFilter || selectedInstitutionFilter.id === "all" || institutionFilterSet.size === 0) {
      return cleanWorks;
    }
    return cleanWorks.filter((work) => {
      const workInstitutionSet = new Set(
        (work.institutions || []).map((institution) => (institution || "").trim().toLowerCase()),
      );
      const groups = selectedInstitutionFilter.institutionGroups || [];
      if (selectedInstitutionFilter.match === "all") {
        if (groups.length > 0) {
          return groups.every((group) =>
            group.some((institution) => workInstitutionSet.has(institution.toLowerCase())),
          );
        }
        return selectedInstitutionFilter.institutions.every((institution) =>
          workInstitutionSet.has(institution.toLowerCase()),
        );
      }
      if (groups.length > 0) {
        return groups.some((group) =>
          group.some((institution) => workInstitutionSet.has(institution.toLowerCase())),
        );
      }
      return selectedInstitutionFilter.institutions.some((institution) =>
        workInstitutionSet.has(institution.toLowerCase()),
      );
    });
  }, [cleanWorks, selectedInstitutionFilter, institutionFilterSet]);

  const dashboardFilteredWorks = useMemo(() => {
    if (venueTypeFilter === "all") return institutionFilteredWorks;
    return institutionFilteredWorks.filter(
      (work) => classifyVenueType(work.venue, venueOverrides) === venueTypeFilter,
    );
  }, [institutionFilteredWorks, venueTypeFilter, venueOverrides]);

  const recentCitationFeedNormalized = useMemo(() => {
    return recentCitationFeed
      .map((entry) => {
        const workId = (entry.workId || "").trim();
        const matched = worksTable.find((w) => w.workId === workId);
        const addedAt = entry.addedAt || entry.citationAddedAt || null;
        if (matched) {
          return { ...matched, addedAt, citedByCount: entry.citedByCount ?? matched.citations } as WorkWithAddedAt;
        }
        const parsedYear =
          entry.year ??
          (() => {
            const t = Date.parse(entry.publicationDate || "");
            return Number.isNaN(t) ? undefined : new Date(t).getFullYear();
          })();
        return {
          workId,
          doi: entry.doi || "",
          program: "",
          primaryAuthorOpenAlexId: "",
          allAuthorOpenAlexIds: [],
          firstAuthorLastName: "",
          allAuthors: entry.allAuthors || [],
          title: entry.title || "",
          publicationDate: entry.publicationDate || "",
          year: parsedYear as number,
          venue: entry.venue || "",
          citations: entry.citedByCount ?? 0,
          fwci: null,
          topics: [],
          institutions: [],
          addedAt,
          citedByCount: entry.citedByCount ?? 0,
        } as WorkWithAddedAt;
      })
      .filter((w) => !!w.addedAt) as WorkWithAddedAt[];
  }, [recentCitationFeed]);

  const recentCitationFeedSorted = useMemo(() => {
    if (!recentCitationFeedNormalized.length) return [];
    const now = Date.now();
    const cutoff = now - recentCitationsWindowDays * 24 * 60 * 60 * 1000;
    return recentCitationFeedNormalized
      .filter((w) => {
        const t = Date.parse(w.addedAt || "");
        return !Number.isNaN(t) && t >= cutoff;
      })
      .sort((a, b) => {
        const ta = Date.parse(a.addedAt || "");
        const tb = Date.parse(b.addedAt || "");
        if (!Number.isNaN(tb - ta)) return tb - ta;
        return (b.citations || 0) - (a.citations || 0);
      });
  }, [recentCitationFeedNormalized, recentCitationsWindowDays]);

  const perYearAggregates = useMemo(() => {
    const map = new Map<
      number,
      { publications: number; citations: number; topics: Set<string>; institutions: Set<string>; coAuthors: Set<string> }
    >();
    for (const work of dashboardFilteredWorks) {
      if (typeof work.year !== "number") continue;
      const entry =
        map.get(work.year) ??
        {
          publications: 0,
          citations: 0,
          topics: new Set<string>(),
          institutions: new Set<string>(),
          coAuthors: new Set<string>(),
        };
      entry.publications += 1;
      entry.citations += work.citations || 0;
      (work.topics || []).forEach((t) => {
        if (t) entry.topics.add(t);
      });
      (work.institutions || []).forEach((inst) => {
        if (inst) entry.institutions.add(inst);
      });
      (work.allAuthors || []).forEach((author) => {
        if (author) entry.coAuthors.add(author);
      });
      map.set(work.year, entry);
    }
    return map;
  }, [dashboardFilteredWorks]);

  const totalPublicationsInRange = useMemo(() => {
    if (!allYears.length) return 0;
    const from = startYear ?? allYears[0];
    const to = endYear ?? allYears[allYears.length - 1];
    return dashboardFilteredWorks.reduce((count, work) => {
      if (typeof work.year !== "number") return count;
      if (work.year < from || work.year > to) return count;
      return count + 1;
    }, 0);
  }, [allYears, startYear, endYear, dashboardFilteredWorks]);

  const totalCitationsInRange = useMemo(() => {
    if (!allYears.length) return 0;
    const from = startYear ?? allYears[0];
    const to = endYear ?? allYears[allYears.length - 1];
    return dashboardFilteredWorks.reduce((sum, work) => {
      if (typeof work.year !== "number") return sum;
      if (work.year < from || work.year > to) return sum;
      return sum + (work.citations || 0);
    }, 0);
  }, [allYears, startYear, endYear, dashboardFilteredWorks]);

  const topicsTotals = useMemo(() => {
    if (!allYears.length) return { total: 0 };
    const from = startYear ?? allYears[0];
    const to = endYear ?? allYears[allYears.length - 1];
    const totalSet = new Set<string>();

    for (const [year, entry] of perYearAggregates.entries()) {
      if (year >= from && year <= to) {
        entry.topics.forEach((t) => totalSet.add(t));
      }
    }

    return {
      total: totalSet.size,
    };
  }, [allYears, startYear, endYear, perYearAggregates]);

  const institutionsTotals = useMemo(() => {
    if (!allYears.length) return { total: 0 };
    const from = startYear ?? allYears[0];
    const to = endYear ?? allYears[allYears.length - 1];
    const totalSet = new Set<string>();

    for (const [year, entry] of perYearAggregates.entries()) {
      if (year >= from && year <= to) {
        entry.institutions.forEach((i) => totalSet.add(i));
      }
    }

    return {
      total: totalSet.size,
    };
  }, [allYears, startYear, endYear, perYearAggregates]);

  const topicsChartData = useMemo(() => {
    const from = startYear ?? (allYears.length ? allYears[0] : undefined);
    const to = endYear ?? (allYears.length ? allYears[allYears.length - 1] : undefined);
    return Array.from(perYearAggregates.entries())
      .sort(([a], [b]) => a - b)
      .filter(([year]) => {
        if (from != null && year < from) return false;
        if (to != null && year > to) return false;
        return true;
      })
      .map(([year, entry]) => ({
        year,
        label: String(year),
        topics: entry.topics.size,
        publications: entry.publications,
        citations: entry.citations,
        institutions: entry.institutions.size,
        coAuthors: entry.coAuthors.size,
      }));
  }, [allYears, startYear, endYear, perYearAggregates]);

  const insightCategories = [
    { key: "emerging", label: "Emerging", icon: Sparkles },
    { key: "declining", label: "Declining", icon: TrendingDown },
    { key: "strongSurge", label: "Strong surge", icon: TrendingUp },
    { key: "growingPriority", label: "Growing priority", icon: ArrowUpRight },
    { key: "impactLed", label: "Impact-led", icon: Target },
    { key: "outputSoftening", label: "Output rising", icon: Activity },
    { key: "stable", label: "Stable", icon: Minus },
  ] as const;

  const insightCategoryDescriptions: Record<
    (typeof insightCategories)[number]["key"],
    (ranges: { aFrom: number; aTo: number; bFrom: number; bTo: number } | null) => string
  > = {
    emerging: (ranges) =>
      ranges ? `Mostly after ${ranges.bFrom}.` : "Mostly after the newer period starts.",
    declining: (ranges) =>
      ranges ? `Much less after ${ranges.bFrom}.` : "Much less after the newer period starts.",
    strongSurge: (ranges) =>
      ranges ? `Sharp rise after ${ranges.bFrom}.` : "Sharp rise in the newer period.",
    growingPriority: (ranges) =>
      ranges ? `Steady rise after ${ranges.bFrom}.` : "Steady rise in the newer period.",
    impactLed: (ranges) =>
      ranges
        ? `Citations outpace publications after ${ranges.bFrom}.`
        : "Citations outpace publications in the newer period.",
    outputSoftening: (ranges) =>
      ranges ? "Publications up, citations lag." : "Publications up, citations lag.",
    stable: (ranges) =>
      ranges
        ? `Little change before vs. after ${ranges.bFrom}.`
        : "Little change over time.",
  };

  const insightRanges = useMemo(() => {
    if (!allYears.length) return null;
    const min = allYears[0];
    const max = allYears[allYears.length - 1];

    const clamp = (value?: number | null) => {
      if (value == null || Number.isNaN(value)) return null;
      return Math.min(Math.max(value, min), max);
    };

    const boundary = clamp(defaultInsightsPeriodB.from) ?? min;

    const rangeFrom = startYear ?? min;
    const rangeTo = endYear ?? max;
    const normalizedFrom = Math.min(rangeFrom, rangeTo);
    const normalizedTo = Math.max(rangeFrom, rangeTo);

    const aFrom = normalizedFrom;
    const aTo = Math.min(normalizedTo, boundary - 1);
    const bFrom = Math.max(normalizedFrom, boundary);
    const bTo = normalizedTo;

    return { aFrom, aTo, bFrom, bTo };
  }, [allYears, startYear, endYear]);

  const insightCounts = useMemo(() => {
    const counts: Record<(typeof insightCategories)[number]["key"], number> = {
      emerging: 0,
      declining: 0,
      strongSurge: 0,
      growingPriority: 0,
      impactLed: 0,
      outputSoftening: 0,
      stable: 0,
    };
    if (!insightRanges) return counts;

    const aggA = hasTopicYearStats
      ? buildAggregatesFromStats(insightRanges.aFrom, insightRanges.aTo)
      : buildAggregatesFromWorks(cleanWorks, insightRanges.aFrom, insightRanges.aTo);
    const aggB = hasTopicYearStats
      ? buildAggregatesFromStats(insightRanges.bFrom, insightRanges.bTo)
      : buildAggregatesFromWorks(cleanWorks, insightRanges.bFrom, insightRanges.bTo);
    const topics = new Set<string>([...aggA.keys(), ...aggB.keys()]);

    topics.forEach((topic) => {
      const a = aggA.get(topic) || { pubs: 0, cites: 0 };
      const b = aggB.get(topic) || { pubs: 0, cites: 0 };
      const insight = deriveInsight(a.pubs, b.pubs, a.cites, b.cites);
      if (insight === "Emerging") counts.emerging += 1;
      else if (insight === "Declining") counts.declining += 1;
      else if (insight === "Strong surge") counts.strongSurge += 1;
      else if (insight === "Growing priority") counts.growingPriority += 1;
      else if (insight === "Impact-led") counts.impactLed += 1;
      else if (insight === "Output rising, impact softening") counts.outputSoftening += 1;
      else if (insight === "Stable") counts.stable += 1;
    });
    return counts;
  }, [cleanWorks, insightRanges, hasTopicYearStats]);

  const insightTotal = useMemo(
    () => Object.values(insightCounts).reduce((sum, value) => sum + value, 0),
    [insightCounts],
  );

  const formatInsightPercent = (value: number) => {
    if (!insightTotal) return "0%";
    const pct = (value / insightTotal) * 100;
    if (pct > 0 && pct < 0.1) return "<0.1%";
    const rounded = Math.round(pct * 10) / 10;
    const text = rounded % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(1);
    return `${text}%`;
  };

  const formatStatCount = (value: number) =>
    Math.abs(value) >= 10_000 ? compactStatFormatter.format(value) : value.toLocaleString();
  const selectedSinceYear = startYear ?? (allYears.length ? allYears[0] : null);

  const rotatingInsights = insightCategories.map(({ key, label, icon: Icon }) => ({
    key,
    label,
    icon: Icon,
    value: formatInsightPercent(insightCounts[key]),
  }));

  const activeInsight = rotatingInsights[activeInsightIndex] ?? rotatingInsights[0] ?? null;

  useEffect(() => {
    if (!rotatingInsights.length || pauseInsightRotation) return;
    const interval = window.setInterval(() => {
      setActiveInsightIndex((prev) => (prev + 1) % rotatingInsights.length);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [rotatingInsights.length, pauseInsightRotation]);

  useEffect(() => {
    if (!rotatingInsights.length) return;
    if (activeInsightIndex >= rotatingInsights.length) {
      setActiveInsightIndex(0);
    }
  }, [activeInsightIndex, rotatingInsights.length]);

  const statTrends = useMemo(() => {
    return {
      topics: topicsChartData.map((d) => d.topics),
      institutions: topicsChartData.map((d) => d.institutions),
      publications: topicsChartData.map((d) => d.publications),
      citations: topicsChartData.map((d) => d.citations),
    };
  }, [topicsChartData]);

  const handleExportChart = (format: "svg" | "png") => {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;

    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svg);
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const chartHeight = Math.max(1, Math.round(rect.height));
    const headerHeight = 36;
    const totalHeight = headerHeight + chartHeight;

    const chartInner = source
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "");

    const estimateTextWidth = (text: string) => Math.max(10, text.length * 7);

    const legendItems = [
      showTopics ? { label: "Topics", color: chartSeriesColors.topics } : null,
      showInstitutions ? { label: "Institutions", color: chartSeriesColors.institutions } : null,
      showPublications ? { label: "Publications", color: chartSeriesColors.publications } : null,
      showCitations ? { label: "Citations", color: chartSeriesColors.citations } : null,
      showCoAuthors ? { label: "Co-authors", color: chartSeriesColors.coAuthors } : null,
    ].filter(Boolean) as { label: string; color: string }[];

    const legendWidth =
      legendItems.reduce((sum, item) => sum + 18 + estimateTextWidth(item.label) + 12, 0) - 12;
    let legendX = Math.max(0, width - legendWidth);
    const headerTextColor = getComputedStyle(document.body).color || "#111827";
    const legendSvg = legendItems
      .map((item) => {
        const x = legendX;
        legendX += 18 + estimateTextWidth(item.label) + 12;
        return `<g transform="translate(${x},8)">
          <rect x="0" y="2" width="12" height="12" rx="2" fill="${item.color}" />
          <text x="18" y="13" fill="${headerTextColor}" font-size="12" font-family="Inter, system-ui, -apple-system, sans-serif">${item.label}</text>
        </g>`;
      })
      .join("");

    const yearText =
      startYear != null && endYear != null
        ? `Year range: ${startYear} to ${endYear}`
        : startYear != null
          ? `Year range from ${startYear}`
          : "";

    const headerSvg = `
      <g>
        ${yearText ? `<text x="0" y="20" fill="${headerTextColor}" font-size="12" font-family="Inter, system-ui, -apple-system, sans-serif">${yearText}</text>` : ""}
        ${legendSvg}
      </g>
    `;

    const combinedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
      <rect width="100%" height="100%" fill="${getComputedStyle(document.body).backgroundColor || "#ffffff"}" />
      ${headerSvg}
      <g transform="translate(0, ${headerHeight})">
        ${chartInner}
      </g>
    </svg>`;

    const blob = new Blob([combinedSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const timestamp = Date.now();

    if (format === "svg") {
      const svgLink = document.createElement("a");
      svgLink.href = url;
      svgLink.download = `topic-stats-${timestamp}.svg`;
      svgLink.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = totalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, width, totalHeight);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return;
        const pngUrl = URL.createObjectURL(pngBlob);
        const link = document.createElement("a");
        link.href = pngUrl;
        link.download = `topic-stats-${timestamp}.png`;
        link.click();
        setTimeout(() => {
          URL.revokeObjectURL(pngUrl);
          URL.revokeObjectURL(url);
        }, 1000);
      }, "image/png");
    };
    img.src = url;
  };

  const rangeFilteredDashboardWorks = useMemo(() => {
    if (!allYears.length) return dashboardFilteredWorks;
    const from = startYear ?? allYears[0];
    const to = endYear ?? allYears[allYears.length - 1];
    return dashboardFilteredWorks.filter((work) => {
      if (typeof work.year !== "number") return false;
      return work.year >= from && work.year <= to;
    });
  }, [allYears, startYear, endYear, dashboardFilteredWorks]);

  const sortedPublications = useMemo(() => {
    return [...rangeFilteredDashboardWorks]
      .sort((a, b) => {
        const aDate = a.publicationDate || `${a.year || 0}-01-01`;
        const bDate = b.publicationDate || `${b.year || 0}-01-01`;
        return bDate.localeCompare(aDate);
      });
  }, [rangeFilteredDashboardWorks]);

  const recentPublications = useMemo(() => {
    return sortedPublications
      .filter((work) => recentPublicationMode === "published" || (work.citations || 0) > 0)
      .slice(0, Math.max(0, publicationLimit));
  }, [sortedPublications, publicationLimit, recentPublicationMode]);

  const publicationPoolSize = useMemo(
    () =>
      sortedPublications.filter(
        (work) => recentPublicationMode === "published" || (work.citations || 0) > 0,
      ).length,
    [sortedPublications, recentPublicationMode],
  );

  const recentTopicSourceWorks = useMemo(
    () => sortedPublications.slice(0, Math.min(sortedPublications.length, RECENT_TOPICS_POOL_SIZE)),
    [sortedPublications],
  );

  const sortedRecentTopics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const work of recentTopicSourceWorks) {
      (work.topics || []).forEach((t) => {
        if (!t) return;
        counts.set(t, (counts.get(t) || 0) + 1);
      });
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [recentTopicSourceWorks]);

  const recentTopics = useMemo(() => {
    return sortedRecentTopics.slice(0, Math.max(0, topicLimit));
  }, [sortedRecentTopics, topicLimit]);

  const fallbackCitedByCitations = useMemo(() => {
    return [...rangeFilteredDashboardWorks]
      .filter((work) => (work.citations ?? 0) > 0)
      .sort((a, b) => {
        const byCites = (b.citations ?? 0) - (a.citations ?? 0);
        if (byCites !== 0) return byCites;
        const byYear = (b.year ?? 0) - (a.year ?? 0);
        if (byYear !== 0) return byYear;
        return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      });
  }, [rangeFilteredDashboardWorks]);

  const displayCitationsSource = recentCitationFeedSorted.length
    ? recentCitationFeedSorted
    : fallbackCitedByCitations;
  const recentCitationsSourceLength = displayCitationsSource.length;

  const recentCitedPublications = useMemo(() => {
    return displayCitationsSource.slice(0, Math.max(0, citedLimit));
  }, [displayCitationsSource, citedLimit]);

  const hasMorePublications = publicationLimit < publicationPoolSize;
  const hasMoreTopics = topicLimit < sortedRecentTopics.length;
  const hasMoreCited = citedLimit < recentCitationsSourceLength;

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

  const handleExportCitingCsv = () => {
    if (!citingWorks.length) return;

    const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    const escape = (value: unknown) => {
      const str = clean(value);
      if (str === "") return "";
      if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };

    const headers = ["title", "year", "venue", "doi", "openalex_id", "cited_by_count", "authors"];
    const rows: string[] = [headers.join(",")];

    for (const work of citingWorks) {
      const authorsLabel = (work.authorships || [])
        .map((a) => a?.author?.display_name)
        .filter(Boolean)
        .join("; ");
      const doiLabel = (work.doi || "").replace(/^https?:\/\/(www\.)?doi\.org\//i, "");
      rows.push(
        [
          escape(work.title || ""),
          escape(work.publication_year || ""),
          escape(work.primary_location?.source?.display_name || ""),
          escape(doiLabel),
          escape(canonicalOpenAlexWorkId(work.id || "")),
          escape(work.cited_by_count || 0),
          escape(authorsLabel),
        ].join(","),
      );
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `citing-publications-page-${citingPage}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const buildRangeParams = () => {
    const from = startYear ?? (allYears.length ? allYears[0] : undefined);
    const to = endYear ?? (allYears.length ? allYears[allYears.length - 1] : undefined);
    const search = new URLSearchParams();
    if (from != null) search.set("fromYear", String(from));
    if (to != null) search.set("toYear", String(to));
    return search;
  };

  return (
    <SiteShell>
      <main className="container mx-auto px-4 py-4 sm:py-8">
        {dashboardConfig.showStats && (
          <div className="mb-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 text-xs sm:text-sm">
              {dashboardConfig.statCards.members && (
                <StatCard
                  title="Members"
                  value={<span title={memberCount.toLocaleString()}>{formatStatCount(memberCount)}</span>}
                  icon={Users}
                  onClick={() => navigate("/members")}
                  actionLabel="view"
                />
              )}
              {dashboardConfig.statCards.topics && (
                <StatCard
                  title="Topics"
                  value={<span title={topicsTotals.total.toLocaleString()}>{formatStatCount(topicsTotals.total)}</span>}
                  trend={{ values: statTrends.topics }}
                  footerNote={selectedSinceYear != null ? `Since: ${selectedSinceYear}` : "Since: -"}
                  actionLabel="view"
                  onClick={() => navigate("/topics")}
                />
              )}
              {dashboardConfig.statCards.institutions && (
                <StatCard
                  title="Institutions"
                  value={
                    <span title={institutionsTotals.total.toLocaleString()}>
                      {formatStatCount(institutionsTotals.total)}
                    </span>
                  }
                  trend={{ values: statTrends.institutions }}
                  footerNote={selectedSinceYear != null ? `Since: ${selectedSinceYear}` : "Since: -"}
                  actionLabel="view"
                  onClick={() => navigate("/institutions")}
                />
              )}
              {dashboardConfig.statCards.publications && (
                <StatCard
                  title="Publications"
                  value={
                    <span title={totalPublicationsInRange.toLocaleString()}>
                      {formatStatCount(totalPublicationsInRange)}
                    </span>
                  }
                  trend={{ values: statTrends.publications }}
                  footerNote={selectedSinceYear != null ? `Since: ${selectedSinceYear}` : "Since: -"}
                  actionLabel="view"
                  onClick={() => navigate("/publications")}
                />
              )}
              {dashboardConfig.statCards.citations && (
                <StatCard
                  title="Citations"
                  value={
                    <span title={totalCitationsInRange.toLocaleString()}>
                      {formatStatCount(totalCitationsInRange)}
                    </span>
                  }
                  trend={{ values: statTrends.citations }}
                  footerNote={selectedSinceYear != null ? `Since: ${selectedSinceYear}` : "Since: -"}
                  actionLabel="view"
                  onClick={() => navigate("/citations")}
                />
              )}
              {dashboardConfig.statCards.insights && (
                <StatCard
                  title="Insights"
                  info={{
                    label: "How Insights work",
                    content: insightRanges ? (
                      <div className="space-y-2">
                        <div>
                          Insights compare topic output and citations between two periods. Each topic
                          is assigned to a category based on how publications and citations change.
                        </div>
                        <div className="text-muted-foreground">
                          Period A: {insightRanges.aFrom}-{insightRanges.aTo}. Period B: {insightRanges.bFrom}-
                          {insightRanges.bTo}.
                        </div>
                      </div>
                    ) : (
                      "Insights compare topic output and citations between two periods."
                    ),
                  }}
                  headerRight={
                    configuredInsightsBoundaryYear != null ? (
                      <span className="text-xs text-foreground whitespace-nowrap">
                        Split year: {configuredInsightsBoundaryYear}
                      </span>
                    ) : null
                  }
                  value={
                    <div className="min-h-[86px] flex items-center justify-center">
                      {activeInsight ? (
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div key={activeInsight.key} className="space-y-1 text-center">
                                <div className="flex items-center justify-center gap-2">
                                  <activeInsight.icon className="h-5 w-5 text-primary" />
                                  <span className="text-4xl sm:text-5xl font-bold text-foreground leading-none">
                                    {activeInsight.value}
                                  </span>
                                </div>
                                <div className="text-xs sm:text-sm font-semibold text-foreground">
                                  {activeInsight.label}
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="start" className="max-w-[240px] text-xs">
                              <div className="font-semibold mb-1">{activeInsight.label}</div>
                              <div>{insightCategoryDescriptions[activeInsight.key](insightRanges)}</div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-sm text-muted-foreground">No insights available</span>
                      )}
                    </div>
                  }
                  valueClassName="w-full !text-base !sm:text-base !font-normal"
                  actionLabel="view"
                  onClick={() => navigate("/insights")}
                  onMouseEnter={() => setPauseInsightRotation(true)}
                  onMouseLeave={() => setPauseInsightRotation(false)}
                  onFocus={() => setPauseInsightRotation(true)}
                  onBlur={() => setPauseInsightRotation(false)}
                />
              )}
            </div>
          </div>
        )}

        {/* Topic & institution trend (single chart) */}
        {dashboardConfig.showCharts && (
          <section className="mb-10">
            <Card className="border-border/60">
              <CardHeader className="relative flex flex-col gap-3 pb-2">
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {allYears.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">Year range:</span>
                      <span className="font-semibold text-foreground">From</span>
                      <select
                        className="h-7 rounded border border-border bg-background px-2 text-xs"
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
                      <span className="font-semibold text-foreground">to</span>
                      <select
                        className="h-7 rounded border border-border bg-background px-2 text-xs"
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">Publication type:</span>
                    <select
                      className="h-7 rounded border border-border bg-background px-2 text-xs"
                      value={venueTypeFilter}
                      onChange={(e) => setVenueTypeFilter(e.target.value as VenueType)}
                    >
                      <option value="all">All publications</option>
                      <option value="journal">Journal</option>
                      <option value="conference">Conference</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  {showInstitutionFilter && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">Institution:</span>
                      <select
                        className="h-7 rounded border border-border bg-background px-2 text-xs"
                        value={institutionFilterId}
                        onChange={(e) => setInstitutionFilterId(e.target.value)}
                      >
                        {institutionFilterOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.shortLabel || option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-3 pr-10">
                    {[
                      { key: "topics", label: "Topics", visible: showTopics, toggle: setShowTopics },
                      { key: "institutions", label: "Institutions", visible: showInstitutions, toggle: setShowInstitutions },
                      { key: "publications", label: "Publications", visible: showPublications, toggle: setShowPublications },
                      { key: "citations", label: "Citations", visible: showCitations, toggle: setShowCitations },
                      { key: "coAuthors", label: "Co-authors", visible: showCoAuthors, toggle: setShowCoAuthors },
                    ].map(({ key, label, visible, toggle }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggle((prev) => !prev)}
                        className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] transition-colors ${
                          visible ? "text-foreground" : "text-muted-foreground"
                        }`}
                        aria-pressed={visible}
                      >
                        <input
                          type="color"
                          value={chartSeriesColors[key as keyof typeof chartSeriesColors]}
                          onChange={(event) =>
                            setChartSeriesColors((prev) => ({
                              ...prev,
                              [key]: event.target.value,
                            }))
                          }
                          className={`h-4 w-4 cursor-pointer rounded-full border border-border bg-transparent p-0 ${
                            visible ? "" : "opacity-50"
                          }`}
                          aria-label={`Set ${label} color`}
                          onClick={(event) => event.stopPropagation()}
                        />
                        <span className={visible ? "" : "opacity-60"}>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="absolute right-3 top-3">
                  <div className="relative flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setShowExportMenu((prev) => !prev)}
                      className="inline-flex items-center justify-center rounded px-2 py-1 text-muted-foreground hover:bg-muted/60"
                      title="Export chart"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    {showExportMenu ? (
                      <div className="absolute right-0 top-9 z-10 min-w-[110px] rounded-md border border-border bg-popover p-1 shadow-lg">
                        <button
                          type="button"
                          className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            handleExportChart("svg");
                            setShowExportMenu(false);
                          }}
                        >
                          Export SVG
                        </button>
                        <button
                          type="button"
                          className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            handleExportChart("png");
                            setShowExportMenu(false);
                          }}
                        >
                          Export PNG
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2 pb-4">
                <div ref={chartRef} className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={topicsChartData}
                        margin={{ top: 0, right: 10, bottom: 12, left: 12 }}
                      >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="year"
                        stroke="hsl(var(--muted-foreground))"
                        axisLine={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.2 }}
                        tickLine={{ stroke: "hsl(var(--muted-foreground))" }}
                        tick={{
                          fill: "hsl(var(--muted-foreground))",
                          fontSize: 12,
                        }}
                        label={{
                          value: "Year",
                          position: "insideBottom",
                          offset: -6,
                          fill: "hsl(var(--muted-foreground))",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        axisLine={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.2 }}
                        tickLine={{ stroke: "hsl(var(--muted-foreground))" }}
                        width={34}
                        tick={{
                          fill: "hsl(var(--muted-foreground))",
                          fontSize: 12,
                        }}
                        domain={[0, "auto"]}
                      />
                      <RechartsTooltip content={<SimpleTooltip />} />
                      {showTopics ? (
                        <Bar
                          dataKey="topics"
                          name="Topics (unique topics)"
                          fill={chartSeriesColors.topics}
                        />
                      ) : null}
                      {showInstitutions ? (
                        <Bar
                          dataKey="institutions"
                          name="Institutions"
                          fill={chartSeriesColors.institutions}
                          opacity={0.85}
                        />
                      ) : null}
                      {showPublications ? (
                        <Bar
                          dataKey="publications"
                          name="Publications"
                          fill={chartSeriesColors.publications}
                          opacity={0.8}
                        />
                      ) : null}
                      {showCitations ? (
                        <Line
                          type="monotone"
                          dataKey="citations"
                          name="Citations"
                          stroke={chartSeriesColors.citations}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 4 }}
                        />
                      ) : null}
                      {showCoAuthors ? (
                        <Line
                          type="monotone"
                          dataKey="coAuthors"
                          name="Co-authors"
                          stroke={chartSeriesColors.coAuthors}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          activeDot={{ r: 4 }}
                        />
                      ) : null}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* Recent publications + Recent publication topics + Recent citations */}
        <section className="space-y-4 mb-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <label htmlFor="recent-publications-mode" className="sr-only">
                    Recent publications mode
                  </label>
                  <select
                    id="recent-publications-mode"
                    className="h-11 min-w-52 rounded-md border border-border bg-background px-3 text-2xl font-bold text-foreground"
                    value={recentPublicationMode}
                    onChange={(event) => {
                      setRecentPublicationMode(event.target.value as RecentPublicationMode);
                      setPublicationLimit(INITIAL_PUBLICATIONS_LIMIT);
                    }}
                  >
                    <option value="published">Recent publications</option>
                    <option value="published_cited">Recent publications and citations</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {recentPublications.map((work, idx) => {
                  const cardKey = work.workId || work.doi || `${work.title || "work"}-${idx}`;
                  const allNames = (work.allAuthors || []).filter(Boolean);
                  const isExpanded = expandedAuthors.has(cardKey);
                  const MAX_VISIBLE_AUTHORS = 8;
                  const hasOverflow = allNames.length > MAX_VISIBLE_AUTHORS;
                  const remaining = hasOverflow ? allNames.length - MAX_VISIBLE_AUTHORS : 0;
                  const visibleNames = isExpanded ? allNames : allNames.slice(0, MAX_VISIBLE_AUTHORS);

                  const toggleAuthors = () => {
                    setExpandedAuthors((prev) => {
                      const next = new Set(prev);
                      if (next.has(cardKey)) next.delete(cardKey);
                      else next.add(cardKey);
                      return next;
                    });
                  };

                  return (
                    <Card key={cardKey} className="border-border/60">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-1">
                              <FileText className="h-3 w-3 text-primary" />
                              <span>
                                {work.publicationDate
                                  ? new Date(work.publicationDate).toLocaleString(undefined, {
                                      year: "numeric",
                                      month: "short",
                                      day: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : work.year || "Year n/a"}
                              </span>
                              {work.venue ? (
                                <>
                                  <span aria-hidden>{"\u2022"}</span>
                                  <span className="text-primary font-medium">{work.venue}</span>
                                </>
                              ) : null}
                            </div>
                            <h3 className="text-sm font-semibold text-primary leading-snug hover:underline">
                              {(() => {
                                const cleanedDoi = work.doi
                                  ? work.doi
                                      .replace(/^https?:\/\/(www\.)?doi\.org\//i, "")
                                      .replace(/^doi:/i, "")
                                      .trim()
                                  : "";
                                const href = cleanedDoi
                                  ? `https://doi.org/${cleanedDoi}`
                                  : work.workId
                                    ? `https://openalex.org/${work.workId}`
                                    : undefined;
                                return (
                                  <a href={href} target="_blank" rel="noreferrer">
                                    {renderWorkTitleHtml(work.title)}
                                  </a>
                                );
                              })()}
                            </h3>
                            {visibleNames.length ? (
                              <p className="text-xs text-muted-foreground mt-1">
                                <User className="mr-1 inline-block h-3 w-3 text-primary" />
                                <span>{visibleNames.join(", ") || "Author n/a"}</span>
                                {hasOverflow ? (
                                  <button
                                    type="button"
                                    className="ml-1 text-primary font-semibold hover:underline"
                                    onClick={toggleAuthors}
                                  >
                                    {isExpanded ? "Show less" : `+${remaining} more`}
                                  </button>
                                ) : null}
                              </p>
                            ) : null}
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <button
                              type="button"
                              className="inline-block text-right hover:underline"
                              onClick={() => openCitingDialog(work)}
                              title="Show citing publications"
                            >
                              <div className="font-semibold text-foreground">
                                {(work.citations || 0).toLocaleString()}
                              </div>
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {publicationPoolSize > INITIAL_PUBLICATIONS_LIMIT && (
                  <>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() =>
                        setPublicationLimit((prev) =>
                          Math.min(prev + PUBLICATIONS_STEP, publicationPoolSize),
                        )
                      }
                      disabled={!hasMorePublications}
                    >
                      Load more
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted"
                  onClick={() => navigate("/publications")}
                >
                  View all
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-2xl font-bold text-foreground">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  <span>Recent publication topics</span>
                </h2>
              </div>
              <Card className="border-border/60">
                <CardContent className="p-3 pb-2">
                  <div className="grid gap-2">
                    {recentTopics.map((topic, idx) => (
                      <div
                        key={topic.name}
                        className="flex items-center justify-between rounded-md border border-border/60 bg-card/60 px-3 py-2"
                        onClick={() => {
                          const search = buildRangeParams();
                          search.set("topic", topic.name);
                          search.set("recentTopics", "1");
                          search.set("recentPool", String(RECENT_TOPICS_POOL_SIZE));
                          navigate(`/publications?${search.toString()}`);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <span className="text-muted-foreground">{idx + 1}.</span>
                          <span className="truncate text-primary hover:underline" title={topic.name}>
                            {topic.name}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {topic.count.toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {sortedRecentTopics.length > INITIAL_TOPICS_LIMIT && (
                  <>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() =>
                        setTopicLimit((prev) => Math.min(prev + TOPICS_STEP, sortedRecentTopics.length))
                      }
                      disabled={!hasMoreTopics}
                    >
                      Load more
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted"
                  onClick={() => navigate("/topics")}
                >
                  View all
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-2xl font-bold text-foreground">
                  <Activity className="h-5 w-5 text-primary" />
                  <span>Recent citations</span>
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {recentCitedPublications.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No new citations in the last {recentCitationsWindowDays} day
                    {recentCitationsWindowDays === 1 ? "" : "s"}.
                  </div>
                ) : (
                  recentCitedPublications.map((work) => (
                    <Card key={`cited-${work.workId}`} className="border-border/60">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-1">
                              <FileText className="h-3 w-3 text-primary" />
                              <span>
                                {(() => {
                                  const addedAt = (work as WorkWithAddedAt).addedAt;
                                  if (addedAt && !Number.isNaN(Date.parse(addedAt))) {
                                    return new Date(addedAt).toLocaleString(undefined, {
                                      year: "numeric",
                                      month: "short",
                                      day: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    });
                                  }
                                  return work.publicationDate
                                    ? new Date(work.publicationDate).toLocaleString(undefined, {
                                        year: "numeric",
                                        month: "short",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : work.year || "Year n/a";
                                })()}
                              </span>
                              {work.venue ? (
                                <>
                                  <span aria-hidden>{"\u2022"}</span>
                                  <span className="text-primary font-medium">{work.venue}</span>
                                </>
                              ) : null}
                            </div>
                            <h3 className="text-sm font-semibold text-primary leading-snug hover:underline">
                              {(() => {
                                const cleanedDoi = work.doi
                                  ? work.doi
                                      .replace(/^https?:\/\/(www\.)?doi\.org\//i, "")
                                      .replace(/^doi:/i, "")
                                      .trim()
                                  : "";
                                const href = cleanedDoi
                                  ? `https://doi.org/${cleanedDoi}`
                                  : work.workId
                                    ? `https://openalex.org/${work.workId}`
                                    : undefined;
                                return (
                                  <a href={href} target="_blank" rel="noreferrer">
                                    {renderWorkTitleHtml(work.title)}
                                  </a>
                                );
                              })()}
                            </h3>
                            {work.allAuthors?.length ? (() => {
                              const names = work.allAuthors.filter(Boolean);
                              const fullList = names.join(", ");
                              return (
                                <p className="text-xs text-muted-foreground mt-1" title={fullList}>
                                  <User className="mr-1 inline-block h-3 w-3 text-primary" />
                                  <span>{fullList || "Author n/a"}</span>
                                </p>
                              );
                            })() : null}
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            {(() => {
                              const trend = workCitationTrendByWorkId[work.workId];
                              const latestYearCitations =
                                trend?.latestYearCitations ??
                                (work as WorkWithAddedAt).citedByCount ??
                                work.citations ??
                                0;
                              const totalCites = trend ? work.citations || 0 : undefined;
                              return (
                                <button
                                  type="button"
                                  className="inline-block text-right hover:underline"
                                  onClick={() => openCitingDialog(work)}
                                  title="Citations gained since last run"
                                >
                                  <div className="font-semibold text-green-600">
                                    +{latestYearCitations.toLocaleString()}
                                  </div>
                                  {totalCites != null ? (
                                    <div className="text-[10px] leading-tight">
                                      {totalCites.toLocaleString()}
                                    </div>
                                  ) : null}
                                </button>
                              );
                            })()}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
              {recentCitedPublications.length > 0 ? (
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  {recentCitationsSourceLength > INITIAL_CITED_LIMIT && (
                    <>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() =>
                          setCitedLimit((prev) =>
                            Math.min(prev + CITED_STEP, recentCitationsSourceLength),
                          )
                        }
                        disabled={!hasMoreCited}
                      >
                        Load more
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted"
                    onClick={() => navigate("/citations")}
                  >
                    View all
                    <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <Dialog open={citingDialogOpen} onOpenChange={setCitingDialogOpen}>
          <DialogContent className="w-[calc(100vw-1rem)] max-w-3xl max-h-[92dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Who cited this paper?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {selectedCitedWork ? (
                <div className="rounded-md border border-border/60 bg-card/40 p-3 text-sm">
                  <div className="font-semibold text-foreground">
                    {renderWorkTitleHtml(selectedCitedWork.title || "Untitled")}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {selectedCitedWork.publicationDate
                      ? new Date(selectedCitedWork.publicationDate).getFullYear()
                      : selectedCitedWork.year || "Year n/a"}
                    {selectedCitedWork.venue ? ` • ${selectedCitedWork.venue}` : ""}
                  </div>
                  {selectedCitedWork.allAuthors?.length ? (
                    <div className="text-xs text-muted-foreground mt-1" title={selectedCitedWork.allAuthors.join(", ")}>
                      <User className="mr-1 inline-block h-3 w-3 text-primary" />
                      <span>{selectedCitedWork.allAuthors.join(", ")}</span>
                    </div>
                  ) : null}
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
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={handleExportCitingCsv}
                      disabled={citingLoading || citingWorks.length === 0}
                      title="Export citing publications (current page)"
                    >
                      <FileText className="mr-1 h-3.5 w-3.5" />
                      Export CSV
                    </button>
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
                            {renderWorkTitleHtml(work.title || "Untitled")}
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
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setCitingPage((p) => Math.max(1, p - 1))}
                      disabled={citingPage <= 1 || citingLoading}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground shadow hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() =>
                        setCitingPage((p) =>
                          Math.min(Math.max(1, Math.ceil(citingTotalCount / citingPerPage)), p + 1),
                        )
                      }
                      disabled={citingLoading || citingPage >= Math.max(1, Math.ceil(citingTotalCount / citingPerPage))}
                    >
                      Next
                    </button>
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

export default Index;


