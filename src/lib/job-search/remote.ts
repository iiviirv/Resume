import type { FoundPosting } from "./search";

/** Infer remote work only from an explicit label or statement, never a keyword match in a skills list. */
export function remoteFromText(title: string, place: string, description: string): true | null {
  const labels = `${title}\n${place}`;
  const text = `${labels}\n${description}`;
  const hybridWork = /\bhybrid[- ](?:work(?:ing)?|role|position|job|schedule|arrangement|attendance|with (?:remote|office|onsite) days)\b|\b(?:role|position|job|work (?:arrangement|model|schedule))\s*(?:is|:)\s*(?:a )?hybrid\b/i.test(text);
  const hybridLabel = /(?:^|[(/|,])\s*hybrid\s*(?:$|[)/|,])/im.test(labels);
  if (hybridWork || hybridLabel || /\b(?:not remote|no remote|remote (?:work )?(?:is )?not (?:available|offered|permitted))\b/i.test(text)) return null;
  return /\bremote\b/i.test(labels) || /\b(?:fully remote|100% remote|remote (?:role|position|job)|work (?:remotely|from home)|remote (?:within|across|in) Canada)\b/i.test(description) ? true : null;
}

/** Reject stated US restrictions for a Canada search. Silence is unknown, not proof of eligibility. */
export function excludesCanada(posting: Pick<FoundPosting, "title" | "place" | "description">): boolean {
  const text = `${posting.title}\n${posting.place}\n${posting.description}`.replace(/\s+/g, " ");
  const us = "(?:U\\.?S\\.?A?\\.?|United States)";
  const onlyUS = new RegExp(`\\b${us}[- ]only\\b|\\bonly (?:open |available )?(?:to |in )?(?:candidates |residents |applicants )?(?:in |of |the )*${us}\\b`, "i");
  const residence = new RegExp(`\\b(?:must|need to|required to) (?:be )?(?:reside|live|be based|located|based) in (?:the )?${us}\\b`, "i");
  const authorization = new RegExp(`\\b(?:must|need to|required to) (?:be )?(?:legally )?(?:authorized|eligible) to work in (?:the )?${us}\\b|\\b${us} (?:work authorization|citizenship) (?:is )?required\\b`, "i");
  // Keep alternatives that explicitly allow Canada, and negated requirements.
  return text.replace(/U\.S\.(?:A\.)?/gi, "United States").split(/[.!?;\n]/).some((sentence) => {
    const stated = sentence.replace(/\bnot (?:US|United States)[- ]only\b/gi, "");
    if (/\b(?:US|United States) (?:or|and) (?:in )?Canada\b|\bCanada (?:or|and) (?:the )?(?:US|United States)\b/i.test(sentence)) return false;
    if (onlyUS.test(stated)) return true;
    if (/\b(?:not|never) (?:need|required)|\b(?:do not|don.t) (?:need|have) to/i.test(sentence)) return false;
    const remoteUS = new RegExp(`\\bremote (?:only )?(?:within|in) (?:the )?${us}\\b`, "i");
    const requiredUS = new RegExp(`\\bmust (?:have (?:valid )?${us} work authorization|be (?:a )?${us} citizen)\\b`, "i");
    return residence.test(sentence) || authorization.test(sentence) || remoteUS.test(sentence) || requiredUS.test(sentence);
  });
}
