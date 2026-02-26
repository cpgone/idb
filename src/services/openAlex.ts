// OpenAlex API client (no API key required)
const BASE_URL = 'https://api.openalex.org';

export interface OpenAlexAuthor {
  id: string;
  display_name: string;
  orcid?: string;
  works_count: number;
  cited_by_count: number;
  display_name_alternatives?: string[];
  h_index: number;
  i10_index: number;
  last_known_institution?: {
    display_name: string;
    country_code?: string;
  };
}

export interface OpenAlexWork {
  id: string;
  title: string;
  publication_year: number;
  cited_by_count: number;
  type: string;
  doi?: string;
  primary_location?: {
    source?: {
      display_name: string;
    };
  };
  authorships: Array<{
    author: {
      id: string;
      display_name: string;
    };
    institutions?: Array<{
      display_name?: string;
    }>;
  }>;
  topics?: Array<{
    display_name: string;
  }>;
  open_access?: {
    is_oa: boolean;
  };
}

export interface OpenAlexPagedResult<T> {
  results: T[];
  count: number;
  page: number;
  perPage: number;
}

export const searchAuthors = async (query: string): Promise<OpenAlexAuthor[]> => {
  const response = await fetch(
    `${BASE_URL}/authors?search=${encodeURIComponent(query)}&per-page=20&mailto=research@example.com`
  );
  
  if (!response.ok) throw new Error('Failed to search authors');
  
  const data = await response.json();
  return data.results;
};

export const getAuthorWorks = async (authorId: string): Promise<OpenAlexWork[]> => {
  const response = await fetch(
    `${BASE_URL}/works?filter=author.id:${authorId}&per-page=100&mailto=research@example.com`
  );
  
  if (!response.ok) throw new Error('Failed to fetch author works');
  
  const data = await response.json();
  return data.results;
};

export const searchWorksByTitle = async (
  authorId: string,
  query: string,
): Promise<OpenAlexWork[]> => {
  const response = await fetch(
    `${BASE_URL}/works?filter=author.id:${authorId}&search=${encodeURIComponent(query)}&per-page=40&mailto=research@example.com`,
  );

  if (!response.ok) throw new Error("Failed to search works by title");

  const data = await response.json();
  return data.results;
};

export const searchWorksGlobalByTitle = async (query: string): Promise<OpenAlexWork[]> => {
  const response = await fetch(
    `${BASE_URL}/works?search=${encodeURIComponent(query)}&per-page=40&mailto=research@example.com`,
  );

  if (!response.ok) throw new Error("Failed to search works by title");

  const data = await response.json();
  return data.results;
};

export const searchWorksByDoi = async (doi: string): Promise<OpenAlexWork[]> => {
  const response = await fetch(
    `${BASE_URL}/works?filter=doi:${encodeURIComponent(doi)}&per-page=5&mailto=research@example.com`,
  );

  if (!response.ok) throw new Error("Failed to search works by DOI");

  const data = await response.json();
  return data.results;
};

export const getAuthorDetails = async (authorId: string): Promise<OpenAlexAuthor> => {
  const response = await fetch(
    `${BASE_URL}/authors/${authorId}?mailto=research@example.com`
  );
  
  if (!response.ok) throw new Error('Failed to fetch author details');
  
  return response.json();
};

const canonicalOpenAlexWorkId = (value: string) =>
  value.replace(/^https?:\/\/(www\.)?openalex\.org\//i, "").trim();

export const getCitingWorks = async (
  workId: string,
  page = 1,
  perPage = 20,
): Promise<OpenAlexPagedResult<OpenAlexWork>> => {
  const canonicalId = canonicalOpenAlexWorkId(workId);
  const response = await fetch(
    `${BASE_URL}/works?filter=cites:${encodeURIComponent(canonicalId)}&sort=publication_date:desc&per-page=${perPage}&page=${page}&mailto=research@example.com`,
  );

  if (!response.ok) throw new Error("Failed to fetch citing works");

  const data = await response.json();
  return {
    results: Array.isArray(data?.results) ? data.results : [],
    count: Number(data?.meta?.count) || 0,
    page: Number(data?.meta?.page) || page,
    perPage: Number(data?.meta?.per_page) || perPage,
  };
};
