import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { canadaLocalJobs, canadaRemoteJobs, jsearchV2LastPage, jsearchV2Page } from "@/test/job-search-fixtures";

import { clearJobSearchCache } from "./cache";
import { postingDetails, searchPostings, testSource } from "./index";
import { EMPTY_QUERY } from "./search";
import { sourceCovers } from "./sources";

const query = { ...EMPTY_QUERY, keywords: "designer", country: "de" };
const ninja = { key: "ak_test", host: "openwebninja" as const };

beforeEach(() => {
  clearJobSearchCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchPostings", () => {
  it("combines Toronto radius and countrywide remote, dedupes links and pages only unfinished branches", async () => {
    let call = 0;
    const requests = stubFetch(() => {
      call += 1;
      return json({ data: call === 1
        ? { jobs: [canadaLocalJobs[0]], cursor: null }
        : call === 2
          ? { jobs: [...canadaRemoteJobs, { ...canadaLocalJobs[0], job_id: "duplicate", job_is_remote: true }, { ...canadaLocalJobs[1], job_id: "onsite", job_apply_link: "https://careers.example/onsite" }], cursor: "remote-2" }
          : { jobs: [{ ...canadaLocalJobs[1], job_is_remote: true }], cursor: null } });
    });
    const combined = { ...query, keywords: "FP&A", country: "ca", place: "Toronto", radiusKm: 50 as const, includeRemote: true };
    const first = await searchPostings("JSEARCH", ninja, combined);
    expect(first.postings.map((posting) => posting.externalId)).toEqual(["ca-0", "remote-ca"]);
    expect(requests[0].url.searchParams.get("radius")).toBe("50");
    expect(requests[1].url.searchParams.get("query")).toBe("FP&A in Canada");
    expect(requests[1].url.searchParams.get("country")).toBe("ca");
    expect(requests[1].url.searchParams.get("work_from_home")).toBe("true");
    expect(requests[1].url.searchParams.has("radius")).toBe(false);
    expect(first.next).toBe('combined:[null,"cursor:remote-2"]');
    const second = await searchPostings("JSEARCH", ninja, combined, first.next);
    expect(requests).toHaveLength(3);
    expect(requests[2].url.searchParams.get("cursor")).toBe("remote-2");
    expect(second.next).toBeNull();
    expect(second.postings[0].externalId).toBe("ca-1");
  });

  it("searches Adzuna remote across Canada and removes explicit US restrictions", async () => {
    const requests = stubFetch(() => json({ count: 2, results: [
      { id: "ca", title: "Remote Analyst", description: "Open to Canada residents." },
      { id: "us", title: "Remote Analyst", description: "US work authorization required." },
      { id: "onsite", title: "Financial Analyst", description: "Experience with remote desktop tools." },
    ] }));
    const page = await searchPostings("ADZUNA", { appId: "app", key: "key" }, { ...query, country: "ca", place: "Toronto", remoteOnly: true });
    expect(page.postings.map((posting) => posting.externalId)).toEqual(["ca"]);
    expect(page.postings[0].remote).toBe(true);
    expect(requests[0].url.pathname).toBe("/v1/api/jobs/ca/search/1");
    expect(requests[0].url.searchParams.get("what")).toBe("designer remote");
    expect(requests[0].url.searchParams.has("where")).toBe(false);
    expect(requests[0].url.searchParams.has("distance")).toBe(false);
  });

  it("asks the source once per half hour for the same search and page", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    const first = await searchPostings("JSEARCH", ninja, query);
    const again = await searchPostings("JSEARCH", ninja, query);
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);

    await searchPostings("JSEARCH", ninja, query, first.next);
    await searchPostings("JSEARCH", ninja, { ...query, remoteOnly: true });
    expect(requests).toHaveLength(3);
  });

  it("doesn't keep failures", async () => {
    let status = 503;
    const requests = stubFetch(() => json(jsearchV2LastPage, { status }));
    await expect(searchPostings("JSEARCH", ninja, query)).rejects.toMatchObject({ problem: "unavailable" });
    status = 200;
    await expect(searchPostings("JSEARCH", ninja, query)).resolves.toMatchObject({ next: null });
    expect(requests).toHaveLength(2);
  });

  it("logs problems with the source without the search, but not a wrong key", async () => {
    const log = vi.mocked(console.error);
    stubFetch(() => json({}, { status: 404 }));
    await expect(searchPostings("JSEARCH", ninja, query)).rejects.toMatchObject({ problem: "changed" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("[job search] Error: JSEARCH: /jsearch/search-v2: HTTP 404");
    expect(String(log.mock.calls[0][0])).not.toContain("designer");

    stubFetch(() => json({}, { status: 401 }));
    await expect(searchPostings("JSEARCH", ninja, { ...query, keywords: "other" })).rejects.toMatchObject({ problem: "key" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("says when a source doesn't cover the country, before asking it", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    await expect(searchPostings("ARBEITSAGENTUR", {}, { ...query, country: "fr" })).rejects.toMatchObject({
      problem: "country",
      message: "Bundesagentur für Arbeit doesn't list jobs in France. Choose another country, or another source in Settings → Job search.",
    });
    expect(requests).toHaveLength(0);
    expect(sourceCovers("ADZUNA", "de")).toBe(true);
    expect(sourceCovers("ADZUNA", "jp")).toBe(false);
    expect(sourceCovers("JSEARCH", "jp")).toBe(true);
  });
});

describe("postingDetails", () => {
  it("returns a complete description as it is", async () => {
    const requests = stubFetch(() => json(jsearchV2Page));
    const [posting] = (await searchPostings("JSEARCH", ninja, query)).postings;
    expect(await postingDetails("JSEARCH", ninja, posting)).toBe(posting.description);
    expect(requests).toHaveLength(1);
  });

  it("asks the source for the rest of an incomplete one, and keeps it", async () => {
    stubFetch(() => json(jsearchV2Page));
    const [posting] = (await searchPostings("JSEARCH", ninja, query)).postings;
    const partial = { ...posting, complete: false };
    expect(await postingDetails("JSEARCH", ninja, partial)).toBe(posting.description);
    expect(await postingDetails("JSEARCH", ninja, { ...partial, description: "" })).toBe(posting.description);
    expect(await postingDetails("JSEARCH", ninja, { ...partial, externalId: "other", description: "" })).toBeNull();
  });
});

describe("testSource", () => {
  it("passes when the source answers", async () => {
    stubFetch(() => json(jsearchV2LastPage));
    await expect(testSource("JSEARCH", ninja)).resolves.toBeUndefined();
  });

  it("throws the problem when it doesn't", async () => {
    stubFetch(() => json({}, { status: 401 }));
    await expect(testSource("JSEARCH", ninja)).rejects.toMatchObject({ problem: "key" });
  });
});
