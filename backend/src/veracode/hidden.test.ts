import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containsWord, isHidden, parseHidden, readHidden, withoutHidden } from "./hidden.js";

const perm = (permission_name: string, permission_description = permission_name) => ({
  permission_name,
  permission_description,
});

describe("hidden permissions", () => {
  it("reads one phrase per line, skipping blanks and comments", () => {
    expect(parseHidden("# a comment\r\n\n  VSA  \nManage Vendor Contact Requests\n#VSA\n")).toEqual(
      ["VSA", "Manage Vendor Contact Requests"],
    );
    expect(parseHidden("")).toEqual([]);
    expect(parseHidden("# only comments\n\n")).toEqual([]);
  });

  it("matches whole words, ignoring case, including camelCase names", () => {
    expect(containsWord("Manage VSA rules", "vsa")).toBe(true);
    expect(containsWord("manageVsaRules", "VSA")).toBe(true);
    expect(containsWord("submitDynamicMPScan", "DynamicMP")).toBe(true);
    expect(containsWord("DynamicMP", "dynamicmp")).toBe(true);
    expect(containsWord("canvsaw", "VSA")).toBe(false);
    expect(
      containsWord(
        "Manage rules in SourceClear workspace",
        "manage rules in sourceclear workspace",
      ),
    ).toBe(true);
    expect(
      containsWord(
        "Manage rules in SourceClear workspaces",
        "Manage rules in SourceClear workspace",
      ),
    ).toBe(false);
  });

  it("hides by name or description and keeps the rest", () => {
    const hidden = ["VSA", "Manage Vendor Contact Requests"];
    expect(isHidden(hidden, perm("x", "Manage Vendor Contact Requests"))).toBe(true);
    expect(isHidden(hidden, perm("viewVsa", "View things"))).toBe(true);
    expect(isHidden([], perm("viewVsa"))).toBe(false);
    const role = { role_name: "r", permissions: [perm("viewVsa"), perm("viewReports")] };
    expect(withoutHidden(hidden, role)).toEqual({
      role_name: "r",
      permissions: [perm("viewReports")],
    });
  });

  it("reads the file, and a missing file hides nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hidden-"));
    try {
      const path = join(dir, "hidden.txt");
      expect(await readHidden(path)).toEqual([]);
      await writeFile(path, "# list\nVSA\n");
      expect(await readHidden(path)).toEqual(["VSA"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
