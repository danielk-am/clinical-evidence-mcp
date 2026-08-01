import { InputError } from "./errors.js";

const IDENTIFIER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    label: "telephone number",
    pattern: /(?:\+?\d[\d\s().-]{6,}\d)/,
  },
  {
    label: "Social Security number",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    label: "medical record number",
    pattern: /\b(?:MRN|medical\s+record\s+number|patient\s+id)\s*[:#=]/i,
  },
  {
    label: "date of birth",
    pattern: /\b(?:DOB|date\s+of\s+birth)\s*[:#=]/i,
  },
];

export function assertDeidentified(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < 2) {
    throw new InputError("Query must contain at least two characters.");
  }

  for (const candidate of IDENTIFIER_PATTERNS) {
    if (candidate.pattern.test(cleaned)) {
      throw new InputError(
        `Query appears to contain a ${candidate.label}. Remove patient identifiers and try again.`,
      );
    }
  }
  return cleaned;
}

export function truncateText(value: unknown, maxLength = 4_000): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return null;
  }
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}
