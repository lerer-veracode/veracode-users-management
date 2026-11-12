import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Permission } from "./identity.js";

// Permissions the dashboard never shows (docs/PLAN_ROLES.md, phase 1), listed by hand in
// config/hidden-permissions.txt.
export const defaultHiddenPath = (): string =>
  process.env.HIDDEN_PERMISSIONS_PATH ??
  resolve(import.meta.dirname, "../../../config/hidden-permissions.txt");

// One word or phrase per line; blank lines and lines starting with # are ignored.
export const parseHidden = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

export const readHidden = async (path: string): Promise<string[]> => {
  try {
    return parseHidden(await readFile(path, "utf8"));
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
};

const isUpper = (c: string) => c !== c.toLowerCase();
const isLower = (c: string) => c !== c.toUpperCase();
const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

// Whether a word starts or ends between s[i - 1] and s[i]: at an edge, next to a space or
// punctuation, or at a camelCase hump ("manage|Vsa", "MP|Scan"), as permission names are camelCase.
const boundary = (s: string, i: number): boolean => {
  const before = s[i - 1];
  const after = s[i];
  if (before === undefined || after === undefined) return true;
  if (!isWordChar(before) || !isWordChar(after)) return true;
  if (isLower(before) && isUpper(after)) return true;
  const next = s[i + 1];
  return isUpper(before) && isUpper(after) && next !== undefined && isLower(next);
};

// Whether text holds phrase as a whole word or words, ignoring case.
export const containsWord = (text: string, phrase: string): boolean => {
  const haystack = text.toLowerCase();
  const needle = phrase.toLowerCase();
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (boundary(text, i) && boundary(text, i + needle.length)) return true;
  }
  return false;
};

export const isHidden = (hidden: string[], p: Permission): boolean =>
  hidden.some(
    (phrase) =>
      containsWord(p.permission_name, phrase) || containsWord(p.permission_description, phrase),
  );

// The same record without its hidden permissions.
export const withoutHidden = <T extends { permissions: Permission[] }>(
  hidden: string[],
  item: T,
): T => ({ ...item, permissions: item.permissions.filter((p) => !isHidden(hidden, p)) });
