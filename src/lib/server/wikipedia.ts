import { z } from "zod";
import { untilAborted } from "@/lib/server/openai";

// Wikimedia policy: a descriptive User-Agent with a contact URL, and nothing else that identifies us.
export const WIKIPEDIA_USER_AGENT = "StoryShotPlanner/1.0 (https://github.com/venkateshmareddy/story-shot-planner)";
export const WIKIPEDIA_LOOKUP_TIMEOUT_MS = 6_000;
// Next's data cache keeps a 200 for a day, so a popular title reaches Wikipedia once, not once per check.
export const WIKIPEDIA_CACHE_SECONDS = 86_400;
export const WIKIPEDIA_SEARCH_LIMIT = 3;
export const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
export const WIKIPEDIA_SEARCH_URL = "https://en.wikipedia.org/w/rest.php/v1/search/title";
const PAGE_URL_PREFIX = "https://en.wikipedia.org/wiki/";
const MAX_QUERY_TITLE = 200;
const MAX_PAGE_URL = 500;
const MAX_RESPONSE_BYTES = 200_000;

export const WORK_MEDIA = ["film", "novel", "tv", "play", "other"] as const;
export type WorkMedium = (typeof WORK_MEDIA)[number];

export type WorkQuery = { title: string; year: number | null; medium: WorkMedium };

export type WikipediaWork = { title: string; description: string; extract: string; url: string };

export type LookupFailure = { status?: number; error: string };

export type WorkLookup = {
  work: WikipediaWork | null;
  requests: number;
  failure: LookupFailure | null;
};

export type WikipediaRequestInit = {
  headers: Record<string, string>;
  signal: AbortSignal;
  next: { revalidate: number };
};
export type WikipediaFetch = (url: string, init: WikipediaRequestInit) => Promise<Response>;

export type LookupOptions = { fetch?: WikipediaFetch; signal?: AbortSignal; timeoutMs?: number };

const HEADERS = { "User-Agent": WIKIPEDIA_USER_AGENT, Accept: "application/json" };

const summarySchema = z.object({
  type: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  extract: z.string().nullish(),
  content_urls: z.object({ desktop: z.object({ page: z.string().nullish() }).nullish() }).nullish(),
});

const searchSchema = z.object({
  pages: z.array(z.object({ key: z.string(), title: z.string(), description: z.string().nullish() })),
});

const WORK_WORDS = `films?|movies?|novels?|novellas?|books?|series|serials?|sitcoms?|miniseries|soap opera|telenovelas?|plays?|musicals?|operas?|ballets?|short stor(?:y|ies)|comics?|graphic novels?|manga|anime|cartoons?|video games?|documentar(?:y|ies)|screenplays?|poems?|fairy tales?|folk ?tales?|fables?|episodes?|animated`;
const WORK = new RegExp(String.raw`\b(?:${WORK_WORDS})\b`, "i");
const NOT_A_WORK =
  /\b(?:director|actor|actress|writer|author|novelist|producer|screenwriter|playwright|poet|singer|musician|rapper|band|composer|company|studio|publisher|characters?|franchise|genre|award|festival|channel|network|magazine|newspaper|politician|surname|given name|disambiguation|referred to|championship|tournament|league|season)\b/i;
const WORK_SENTENCE = new RegExp(
  String.raw`\b(?:is|was|are|were)\s+(?:an?|the)\b[^.]{0,80}?\b(?:${WORK_WORDS})\b(?!\s+(?:director|maker|producer|critic|editor|composer|studio|company|actor|actress|writer)s?\b)`,
  "i",
);
const MEDIUM_WORDS: Record<WorkMedium, RegExp | null> = {
  film: /\b(?:film|movie)\b/i,
  novel: /\b(?:novel|book|novella)\b/i,
  tv: /\b(?:television|tv|series|sitcom|miniseries)\b/i,
  play: /\b(?:play|musical)\b/i,
  other: null,
};

const firstSentence = (text: string) => text.split(/(?<=[.!?])\s/, 1)[0].slice(0, 300);

export function isCreativeWork(description: string, extract: string): boolean {
  const said = description.trim();
  if (said) {
    if (NOT_A_WORK.test(said)) return false;
    if (WORK.test(said)) return true;
  }
  return WORK_SENTENCE.test(firstSentence(extract));
}

const describesWork = (description: string) => !NOT_A_WORK.test(description) && WORK.test(description);
const baseTitle = (title: string) =>
  title
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
const pageKey = (title: string) => title.trim().replace(/\s+/g, "_");

function cleanQueryTitle(title: string): string {
  return title
    .replace(/\p{Cc}+/gu, " ")
    .replace(/^[\s"'“”‘’*_]+|[\s"'“”‘’*_]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_QUERY_TITLE)
    .trim();
}

class LookupError extends Error {
  constructor(readonly status?: number) {
    super("Wikipedia lookup failed");
    this.name = "LookupError";
  }
}

// A 404 is a miss; rate limits, blocks and server errors mean Wikipedia is unavailable.
const isUnavailable = (status: number) => status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;

type Page = { kind: "work"; work: WikipediaWork } | { kind: "miss"; title?: string };

type Send = (url: string) => Promise<Response>;

// Not awaited: cancelling one branch of a teed body only settles once every branch is cancelled.
const discard = (response: Response) => void response.body?.cancel().catch(() => {});

async function readJson(response: Response): Promise<unknown | null> {
  if (!response.ok) {
    discard(response);
    if (isUnavailable(response.status)) throw new LookupError(response.status);
    return null;
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    discard(response);
    throw new LookupError(response.status);
  }
  return response.json();
}

async function summary(send: Send, title: string): Promise<Page> {
  const json = await readJson(await send(`${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(pageKey(title))}`));
  if (json === null) return { kind: "miss" };
  const parsed = summarySchema.safeParse(json);
  if (!parsed.success) throw new LookupError();
  const page = parsed.data;
  if (page.type !== "standard") return { kind: "miss", title: page.title };
  const description = page.description?.trim() ?? "";
  const extract = page.extract?.trim() ?? "";
  const url = page.content_urls?.desktop?.page?.trim() ?? "";
  const citable = url.startsWith(PAGE_URL_PREFIX) && url.length <= MAX_PAGE_URL && z.url().safeParse(url).success;
  if (!extract || !page.title.trim() || !citable || !isCreativeWork(description, extract)) {
    return { kind: "miss", title: page.title };
  }
  return { kind: "work", work: { title: page.title.trim(), description, extract, url } };
}

type SearchHit = z.infer<typeof searchSchema>["pages"][number];

function hitScore(query: WorkQuery, hit: SearchHit): number {
  const description = hit.description?.trim() ?? "";
  if (description && !describesWork(description)) return -1;
  const about = `${hit.title} ${description}`;
  let score = description ? 4 : 0;
  if (query.year && about.includes(String(query.year))) score += 2;
  if (MEDIUM_WORDS[query.medium]?.test(about)) score += 1;
  if (baseTitle(hit.title) === baseTitle(query.title)) score += 1;
  return score;
}

async function searchTitle(send: Send, query: WorkQuery, tried: readonly string[]): Promise<string | null> {
  const params = new URLSearchParams({ q: query.title, limit: String(WIKIPEDIA_SEARCH_LIMIT) });
  const json = await readJson(await send(`${WIKIPEDIA_SEARCH_URL}?${params}`));
  if (json === null) return null;
  const parsed = searchSchema.safeParse(json);
  if (!parsed.success) throw new LookupError();
  const skip = new Set(tried.map((title) => pageKey(title).toLowerCase()));
  const best = parsed.data.pages
    .map((hit, index) => ({ hit, index, score: hitScore(query, hit) }))
    .filter(({ hit, score }) => score >= 0 && !skip.has(pageKey(hit.key).toLowerCase()))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
  return best?.hit.key ?? null;
}

function failureOf(error: unknown): LookupFailure {
  if (error instanceof LookupError) return error.status ? { status: error.status, error: error.name } : { error: error.name };
  return { error: error instanceof Error ? error.name : typeof error };
}

export async function lookupWork(query: WorkQuery, options: LookupOptions = {}): Promise<WorkLookup> {
  const title = cleanQueryTitle(query.title);
  if (!title) return { work: null, requests: 0, failure: null };
  const fetchPage: WikipediaFetch = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? WIKIPEDIA_LOOKUP_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let requests = 0;
  const send: Send = (url) => {
    requests += 1;
    return untilAborted(fetchPage(url, { headers: { ...HEADERS }, signal, next: { revalidate: WIKIPEDIA_CACHE_SECONDS } }), signal);
  };
  try {
    const direct = await summary(send, title);
    if (direct.kind === "work") return { work: direct.work, requests, failure: null };
    const key = await searchTitle(send, { ...query, title }, [title, ...(direct.title ? [direct.title] : [])]);
    if (!key) return { work: null, requests, failure: null };
    const found = await summary(send, key);
    return { work: found.kind === "work" ? found.work : null, requests, failure: null };
  } catch (error) {
    return { work: null, requests, failure: failureOf(error) };
  }
}
