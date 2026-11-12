import { describe, expect, it } from "vitest";
import { ROLES, USERS } from "../mock/data";
import { parseUsersCsv } from "./csv";
import { formatDateTime, fullName } from "./format";
import { planImport } from "./importPlan";
import { EMPTY_FILTERS, filterUsers, pageCount, pageOf, sortUsers } from "./users";
import { daysLeft } from "./retention";

describe("formatDateTime", () => {
  it("formats like the platform", () => {
    expect(formatDateTime(new Date(2026, 10, 2, 16, 50).toISOString())).toBe("2 Nov 2026 4:50PM");
    expect(formatDateTime(new Date(2026, 0, 5, 0, 7).toISOString())).toBe("5 Jan 2026 12:07AM");
  });
  it("shows Never for no date", () => {
    expect(formatDateTime(null)).toBe("Never");
  });
  it("joins names", () => {
    expect(fullName({ first_name: "Jane", last_name: "Doe" })).toBe("Jane Doe");
  });
});

describe("parseUsersCsv", () => {
  it("parses rows, roles and defaults", () => {
    const { rows, error } = parseUsersCsv(
      "user_name,email_address,roles\njdoe,jdoe@example.com,extseclead; extreviewer\n",
    );
    expect(error).toBeNull();
    expect(rows[0]).toMatchObject({
      line: 2,
      user_name: "jdoe",
      first_name: "jdoe",
      roles: ["extseclead", "extreviewer"],
      errors: [],
    });
  });
  it("reports missing columns", () => {
    expect(parseUsersCsv("user_name,email\nx,y").error).toBe(
      "Missing columns: email_address, roles",
    );
  });
  it("flags invalid rows", () => {
    const { rows } = parseUsersCsv("user_name,email_address,roles\n,not-an-email,\n");
    expect(rows[0]?.errors).toEqual([
      "User name is required",
      "Email address is not valid",
      "At least one role is required",
    ]);
  });
});

describe("planImport", () => {
  it("works out what each row does", () => {
    const u = USERS[1];
    if (!u) throw new Error("mock data");
    const roles = u.roles.map((r) => r.role_name).join(";");
    const csv = [
      "user_name,email_address,first_name,last_name,roles",
      `x,${u.email_address},${u.first_name},${u.last_name},${roles}`,
      `x,${u.email_address.toUpperCase()},${u.first_name},${u.last_name},extreviewer`,
      "new,new@example.com,New,Person,extreviewer",
      "bad,bad@example.com,Bad,Role,notarole",
    ].join("\n");
    const plan = planImport(parseUsersCsv(csv).rows, USERS, ROLES);
    expect(plan.map((p) => p.action)).toEqual(["No change", "Update", "Create", "Error"]);
    expect(plan[3]?.errors).toEqual(["Unknown roles: notarole"]);
  });
});

describe("user list helpers", () => {
  it("filters by search, type, status and role", () => {
    expect(filterUsers(USERS, EMPTY_FILTERS)).toHaveLength(USERS.length);
    expect(filterUsers(USERS, { ...EMPTY_FILTERS, search: "PRIYA" })).toHaveLength(1);
    const api = filterUsers(USERS, { ...EMPTY_FILTERS, types: ["API"] });
    expect(api.every((u) => u.user_type === "API")).toBe(true);
    const inactive = filterUsers(USERS, { ...EMPTY_FILTERS, status: "inactive" });
    expect(inactive.every((u) => !u.active)).toBe(true);
    const admins = filterUsers(USERS, { ...EMPTY_FILTERS, role: "adminapi" });
    expect(admins.map((u) => u.user_name)).toEqual(["api_aautomation"]);
  });
  it("sorts both ways, with missing values first", () => {
    const asc = sortUsers(USERS, { key: "user_name", dir: "asc" });
    const desc = sortUsers(USERS, { key: "user_name", dir: "desc" });
    expect(asc[0]?.user_name).toBe(desc[desc.length - 1]?.user_name);
    expect(sortUsers(USERS, { key: "last_login", dir: "asc" })[0]?.last_login).toBeNull();
  });
  it("pages", () => {
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(pageCount(23, 10)).toBe(3);
    expect(pageCount(0, 10)).toBe(1);
  });
});

describe("daysLeft", () => {
  it("rounds up and never goes below zero", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(daysLeft("2026-11-10T13:00:00Z", now)).toBe(2);
    expect(daysLeft("2026-11-01T00:00:00Z", now)).toBe(0);
  });
});
