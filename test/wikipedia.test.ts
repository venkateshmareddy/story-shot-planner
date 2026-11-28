import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCreativeWork,
  lookupWork,
  WIKIPEDIA_SEARCH_URL,
  WIKIPEDIA_SUMMARY_URL,
  WIKIPEDIA_USER_AGENT,
  type WikipediaFetch,
  type WikipediaRequestInit,
  type WorkQuery,
} from "../src/lib/server/wikipedia.ts";

type Sent = { url: string; init: WikipediaRequestInit };
type Reply = Response | (() => Promise<Response>);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function summaryPage(title: string, description: string, extract: string, type = "standard") {
  const key = title.replace(/ /g, "_");
  return { type, title, description, extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}` } } };
}

function fakeWikipedia(routes: Record<string, Reply>) {
  const sent: Sent[] = [];
  const fetch: WikipediaFetch = async (url, init) => {
    sent.push({ url, init });
    const reply = routes[url];
    if (!reply) return json({ title: "Not found." }, 404);
    return typeof reply === "function" ? reply() : reply.clone();
  };
  return { fetch, sent };
}

const summaryUrl = (key: string) => `${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(key)}`;
const searchUrl = (q: string) => `${WIKIPEDIA_SEARCH_URL}?${new URLSearchParams({ q, limit: "3" })}`;
const query = (title: string, medium: WorkQuery["medium"] = "film", year: number | null = null): WorkQuery => ({ title, year, medium });

const CAST_AWAY = summaryPage(
  "Cast Away",
  "2000 film by Robert Zemeckis",
  "Cast Away is a 2000 American survival drama film directed by Robert Zemeckis. A FedEx employee is stranded on an uninhabited island after his plane crashes in the South Pacific.",
);

test("a direct summary hit for a film is returned after one request with only the title in the URL", async () => {
  const { fetch, sent } = fakeWikipedia({ [summaryUrl("Cast_Away")]: json(CAST_AWAY) });
  const result = await lookupWork(query("Cast Away", "film", 2000), { fetch });
  assert.equal(result.failure, null);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.work, {
    title: "Cast Away",
    description: "2000 film by Robert Zemeckis",
    extract: CAST_AWAY.extract,
    url: "https://en.wikipedia.org/wiki/Cast_Away",
  });
  assert.equal(sent[0].url, "https://en.wikipedia.org/api/rest_v1/page/summary/Cast_Away");
  assert.equal(sent[0].init.headers["User-Agent"], WIKIPEDIA_USER_AGENT);
  assert.equal(WIKIPEDIA_USER_AGENT, "StoryShotPlanner/1.0 (https://github.com/venkateshmareddy/story-shot-planner)");
  assert.deepEqual(Object.keys(sent[0].init).sort(), ["headers", "next", "signal"], "no body, no method, no cookies");
  assert.deepEqual(Object.keys(sent[0].init.headers).sort(), ["Accept", "User-Agent"]);
});

test("a disambiguation page leads to one title search and the summary of the best matching hit", async () => {
  const lost = summaryPage("Lost (TV series)", "American television series (2004–2010)", "Lost is an American television series. Survivors of a plane crash live on a mysterious island.");
  const { fetch, sent } = fakeWikipedia({
    [summaryUrl("Lost")]: json(summaryPage("Lost", "Topics referred to by the same term", "Lost may refer to:", "disambiguation")),
    [searchUrl("Lost")]: json({
      pages: [
        { key: "Lost", title: "Lost", description: "Topics referred to by the same term" },
        { key: "Lost_in_Translation_(film)", title: "Lost in Translation (film)", description: "2003 film by Sofia Coppola" },
        { key: "Lost_(TV_series)", title: "Lost (TV series)", description: "American television series (2004–2010)" },
      ],
    }),
    [summaryUrl("Lost_(TV_series)")]: json(lost),
  });
  const result = await lookupWork(query("Lost", "tv", 2004), { fetch });
  assert.equal(result.work?.title, "Lost (TV series)");
  assert.equal(result.requests, 3);
  assert.equal(result.failure, null);
  assert.deepEqual(
    sent.map(({ url }) => url),
    [summaryUrl("Lost"), searchUrl("Lost"), summaryUrl("Lost_(TV_series)")],
  );
  assert.ok(sent.every(({ init }) => init.headers["User-Agent"] === WIKIPEDIA_USER_AGENT));
});

test("a page that isn't a creative work is never accepted, and a search without a work hit stops there", async () => {
  const island = summaryPage("The Island", "Island in the South Pacific", "The Island is a small island in the South Pacific.");
  const director = summaryPage("Robert Zemeckis", "American film director (born 1951)", "Robert Zemeckis is an American filmmaker.");
  const { fetch, sent } = fakeWikipedia({
    [summaryUrl("The_Island")]: json(island),
    [searchUrl("The Island")]: json({ pages: [{ key: "The_Island", title: "The Island", description: "Island in the South Pacific" }] }),
    [summaryUrl("Robert_Zemeckis")]: json(director),
  });
  const island1 = await lookupWork(query("The Island"), { fetch });
  assert.deepEqual(island1, { work: null, requests: 2, failure: null });
  const person = await lookupWork(query("Robert Zemeckis"), { fetch });
  assert.equal(person.work, null);
  assert.equal(sent.length, 4, "the person lookup searched once and found nothing");
});

test("a missing page (404) searches once; the summary of a film hit is accepted", async () => {
  const film = summaryPage("The Island (2005 film)", "2005 film by Michael Bay", "The Island is a 2005 American science fiction action film.");
  const { fetch } = fakeWikipedia({
    [searchUrl("The Island")]: json({
      pages: [
        { key: "The_Island_(novel)", title: "The Island (novel)", description: "1962 novel by Aldous Huxley" },
        { key: "The_Island_(2005_film)", title: "The Island (2005 film)", description: "2005 film by Michael Bay" },
      ],
    }),
    [summaryUrl("The_Island_(2005_film)")]: json(film),
  });
  const result = await lookupWork(query("The Island", "film", 2005), { fetch });
  assert.equal(result.work?.title, "The Island (2005 film)");
  assert.equal(result.requests, 3);
});

test("network errors, rate limits and server errors are failures; nothing throws", async () => {
  const down: WikipediaFetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await lookupWork(query("Cast Away"), { fetch: down }), { work: null, requests: 1, failure: { error: "TypeError" } });
  for (const status of [429, 503]) {
    const { fetch } = fakeWikipedia({ [summaryUrl("Cast_Away")]: json({}, status) });
    assert.deepEqual(await lookupWork(query("Cast Away"), { fetch }), {
      work: null,
      requests: 1,
      failure: { status, error: "LookupError" },
    });
  }
  const { fetch: html } = fakeWikipedia({ [summaryUrl("Cast_Away")]: new Response("<html>", { status: 200 }) });
  assert.equal((await lookupWork(query("Cast Away"), { fetch: html })).failure?.error, "SyntaxError");
});

test("a lookup that hangs fails at its timeout", async () => {
  const hung: WikipediaFetch = () => new Promise<Response>(() => {});
  const started = Date.now();
  const result = await lookupWork(query("Cast Away"), { fetch: hung, timeoutMs: 30 });
  assert.equal(result.work, null);
  assert.ok(result.failure);
  assert.ok(Date.now() - started < 2_000);
});

test("only the cleaned work title is sent: quotes stripped, slashes encoded, blank titles send nothing", async () => {
  const { fetch, sent } = fakeWikipedia({});
  await lookupWork(query("“Face/Off”"), { fetch });
  assert.equal(sent[0].url, `${WIKIPEDIA_SUMMARY_URL}Face%2FOff`);
  assert.equal(sent[1].url, searchUrl("Face/Off"));
  const before = sent.length;
  assert.deepEqual(await lookupWork(query('  "" '), { fetch }), { work: null, requests: 0, failure: null });
  assert.equal(sent.length, before);
});

test("isCreativeWork reads the description first, then the opening sentence", () => {
  assert.ok(isCreativeWork("1937 novel by J. R. R. Tolkien", ""));
  assert.ok(isCreativeWork("Play by William Shakespeare", ""));
  assert.ok(isCreativeWork("American television sitcom (1994–2004)", ""));
  assert.ok(isCreativeWork("", "Amélie is a 2001 French romantic comedy film. It follows a shy waitress."));
  assert.ok(!isCreativeWork("American film director", "Jane Doe is an American film director."));
  assert.ok(!isCreativeWork("Fictional character in Cast Away", "Wilson is a volleyball."));
  assert.ok(!isCreativeWork("American media franchise", "Star Wars is a space opera media franchise."));
  assert.ok(!isCreativeWork("Literary genre", "Robinsonade is a genre of fiction."));
  assert.ok(!isCreativeWork("", "Jane Doe is an American film director and writer."));
  assert.ok(!isCreativeWork("", "Paris is the capital of France."));
});
