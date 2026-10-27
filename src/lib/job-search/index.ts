import "server-only";

import { z } from "zod";

import { logServerError } from "@/lib/log";

import type { JobSourceAdapter, RequestContext, SourceCredentials } from "./adapter";
import { cached, remember } from "./cache";
import { JobSearchError, jobSearchError } from "./errors";
import { adzuna } from "./adzuna";
import { arbeitsagentur } from "./arbeitsagentur";
import { jsearch } from "./jsearch";
import { excludesCanada, remoteFromText } from "./remote";
import { linkKey, postingKey, type FoundPosting, type JobSource, type SearchPage, type SearchQuery } from "./search";
import { sourceCovers } from "./sources";

// Searching the chosen job source from the server (E14-1). Results are
// cached for half an hour; failures come back as JobSearchError with a
// message for the screen, and the ones that point at a problem with the
// source are logged, without the search.

export type { JSearchHost, RequestContext, SourceCredentials } from "./adapter";
export { JobSearchError } from "./errors";

const ADAPTERS: { [S in JobSource]: JobSourceAdapter<S> } = {
  JSEARCH: jsearch,
  ADZUNA: adzuna,
  ARBEITSAGENTUR: arbeitsagentur,
};

const adapterFor = <S extends JobSource>(source: S) => ADAPTERS[source] as JobSourceAdapter<S>;

/** Logs failures that say something about the source; a wrong key or a used-up quota is the user's to fix. */
async function logged<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof JobSearchError && (error.problem === "changed" || error.problem === "unavailable")) {
      logServerError("job search", new Error(error.detail ?? error.message));
    }
    throw error;
  }
}

/** One page of postings for `query` from `source`, from the cache when it was asked for in the last half hour. */
export async function searchPostings<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  query: SearchQuery,
  next: string | null = null,
  context: RequestContext = {},
): Promise<SearchPage> {
  if (!sourceCovers(source, query.country)) throw jobSearchError("country", source, { country: query.country });
  if (query.includeRemote && !query.remoteOnly) {
    const cursors = next?.startsWith("combined:")
      ? z.tuple([z.string().nullable(), z.string().nullable()]).parse(JSON.parse(next.slice(9)))
      : [null, null];
    const branches = [
      { ...query, includeRemote: false },
      { ...query, includeRemote: false, remoteOnly: true, place: "" },
    ];
    const pages: SearchPage[] = [];
    for (const [index, branch] of branches.entries()) {
      // A null cursor on a later page means this branch is exhausted.
      pages.push(next && cursors[index] === null
        ? { postings: [], next: null }
        : await searchPostings(source, credentials, branch, cursors[index], context));
    }
    const seen = new Set<string>();
    const postings = pages.flatMap((page) => page.postings).filter((posting) => {
      const id = postingKey(posting);
      const link = linkKey(posting.url);
      if (seen.has(id) || (link && seen.has(link))) return false;
      seen.add(id);
      if (link) seen.add(link);
      return true;
    });
    return { postings, next: pages.some((page) => page.next) ? `combined:${JSON.stringify(pages.map((page) => page.next))}` : null };
  }
  // Remote eligibility is countrywide; a city radius would hide eligible roles elsewhere.
  if (query.remoteOnly) query = { ...query, place: "" };
  const adapter = adapterFor(source);
  const key = `search:${source}:${JSON.stringify(query)}:${next ?? ""}`;
  const hit = cached<SearchPage>(key);
  if (hit) return hit;
  const answer = await logged(() => adapter.search(query, credentials, next, context));
  const page = {
    ...answer,
    postings: answer.postings
      .map((posting) => ({ ...posting, remote: posting.remote ?? remoteFromText(posting.title, posting.place, posting.description) }))
      // Adzuna has no remote filter; its keyword matches need explicit remote wording.
      .filter((posting) => !query.remoteOnly || (source === "ADZUNA" ? posting.remote === true : posting.remote !== false))
      .filter((posting) => !(query.country === "ca" && (posting.remote || query.remoteOnly) && excludesCanada(posting))),
  };
  remember(key, page);
  return page;
}

/** The whole text of a posting: its own description when that's complete, else fetched; null when it can't be had. */
export async function postingDetails<S extends JobSource>(
  source: S,
  credentials: SourceCredentials[S],
  posting: FoundPosting,
  context: RequestContext = {},
): Promise<string | null> {
  if (posting.complete) return posting.description;
  const key = `details:${postingKey(posting)}`;
  const hit = cached<string>(key);
  if (hit) return hit;
  const text = await logged(() => adapterFor(source).details(posting, credentials, context));
  if (text) remember(key, text);
  return text;
}

/** "Test connection" in Settings → Job search: throws a JobSearchError when the source or the key doesn't work. */
export async function testSource<S extends JobSource>(source: S, credentials: SourceCredentials[S], context: RequestContext = {}): Promise<void> {
  await logged(() => adapterFor(source).test(credentials, context));
}
