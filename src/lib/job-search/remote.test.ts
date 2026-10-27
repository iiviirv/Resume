import { describe, expect, it } from "vitest";

import { excludesCanada, remoteFromText } from "./remote";

const posting = (description: string) => ({ title: "Analyst", place: "Remote", description });

describe("remote eligibility", () => {
  it("removes stated US restrictions while retaining Canadian, worldwide and unknown eligibility", () => {
    for (const description of ["US-only", "U.S. only", "Only open to residents of the United States", "Must reside in the US", "Must be based in the United States", "Must be legally authorized to work in the U.S.", "US work authorization is required", "US citizenship required", "Remote within the United States", "Must have US work authorization", "Must be a US citizen"]) {
      expect(excludesCanada(posting(description)), description).toBe(true);
    }
    for (const description of ["Open to Canada and US residents", "Worldwide remote", "Must be authorized to work in Canada", "US work authorization is not required", "This role is not US-only", "You do not need to be authorized to work in the US", "Must be authorized to work in the US or Canada", "We have US clients", "US company, hiring remotely in Canada", ""]) {
      expect(excludesCanada(posting(description)), description).toBe(false);
    }
  });

  it("preserves Canada alternatives before rejecting a US-only prefix", () => {
    for (const description of [
      "Only open to residents of the United States or Canada",
      "Only open to residents of the U.S. or Canada",
      "Only available to applicants in Canada or the US",
    ]) {
      expect(excludesCanada(posting(description)), description).toBe(false);
    }
    expect(excludesCanada(posting("Only open to residents of the United States"))).toBe(true);
    expect(excludesCanada(posting("Only open to residents of the United States or Canada. US work authorization required."))).toBe(true);
  });

  it("keeps remote labels when hybrid describes technology rather than attendance", () => {
    expect(remoteFromText("Remote Data Engineer", "Canada", "Experience with hybrid cloud environments")).toBe(true);
    expect(remoteFromText("Remote Senior Financial Analyst", "Canada", "Build reports using hybrid cloud platforms.")).toBe(true);
    expect(remoteFromText("Remote Data Engineer, Hybrid Cloud", "Canada", "")).toBe(true);
    expect(remoteFromText("Senior Financial Analyst", "Canada", "Fully remote role. Experience with hybrid cloud environments.")).toBe(true);
    for (const description of [
      "Hybrid work arrangement, with two days in the office.",
      "This role is hybrid.",
      "Hybrid schedule with remote days.",
      "Hybrid with remote days.",
      "Work arrangement: hybrid.",
    ]) {
      expect(remoteFromText("Remote Senior Financial Analyst", "Toronto", description), description).toBeNull();
    }
    expect(remoteFromText("Remote Senior Financial Analyst", "Toronto (Hybrid)", "")).toBeNull();
    expect(remoteFromText("Remote Senior Financial Analyst (Hybrid)", "Toronto", "")).toBeNull();
  });

  it("labels explicit remote roles without treating hybrid work or remote tools as fully remote", () => {
    expect(remoteFromText("Remote Financial Analyst", "Canada", "")).toBe(true);
    expect(remoteFromText("Financial Analyst", "Toronto", "Work remotely within Canada.")).toBe(true);
    expect(remoteFromText("Financial Analyst", "Remote, Canada", "")).toBe(true);
    for (const description of ["Experience with remote desktop tools.", "Hybrid with remote days.", "Remote work is not available.", ""]) {
      expect(remoteFromText("Financial Analyst", "Toronto", description)).toBeNull();
    }
  });
});
