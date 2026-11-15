import { describe, expect, it } from "vitest";
import { ROLES, USERS } from "../mock/data";
import { parseUsersCsv } from "./csv";
import { formatDateTime, fullName } from "./format";
import { planImport } from "./importPlan";
import { EMPTY_FILTERS, filterUsers, pageCount, pageOf, sortUsers } from "./users";
import { daysLeft } from "./retention";
import { roleView } from "./roles";

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
      scan_types: [],
      errors: [],
    });
  });
  it("uses the email address for an empty user name, and the column is optional", () => {
    expect(
      parseUsersCsv("user_name,email_address,roles\n,a@example.com,x").rows[0]?.user_name,
    ).toBe("a@example.com");
    expect(parseUsersCsv("email_address,roles\na@example.com,x").rows[0]?.user_name).toBe(
      "a@example.com",
    );
  });
  it("reports missing columns", () => {
    expect(parseUsersCsv("user_name,email\nx,y").error).toBe(
      "Missing columns: email_address, roles",
    );
  });
  it("flags invalid rows", () => {
    expect(
      parseUsersCsv("user_name,email_address,roles\nx,not-an-email,\n").rows[0]?.errors,
    ).toEqual(["Email address is not valid", "At least one role is required"]);
    expect(parseUsersCsv("user_name,email_address,roles\nx y,,r\n").rows[0]?.errors).toEqual([
      "Email address is required",
      "A user name can't contain spaces or be over 256 characters",
    ]);
  });
});

describe("planImport", () => {
  const plan = (...lines: string[]) =>
    planImport(
      parseUsersCsv(["user_name,email_address,roles,scan_types", ...lines].join("\n")).rows,
      USERS,
      ROLES,
    );
  const give = (p: { give: { role_name: string }[] } | undefined) =>
    p?.give.map((r) => r.role_name);

  it("creates new users only, and names who has a user name already", () => {
    const u = USERS[1];
    if (!u) throw new Error("mock data");
    const [taken, upper, fresh] = plan(
      `,${u.user_name},extreviewer,`,
      `${u.user_name.toUpperCase()},new@example.com,extreviewer,`,
      `new,${u.email_address},extreviewer,`,
    );
    expect(taken?.action).toBe("Error");
    expect(taken?.errors).toEqual([
      `${u.user_name} is already the user name of ${u.first_name} ${u.last_name}, ${u.email_address}`,
    ]);
    expect(upper?.action).toBe("Error");
    // Several users may share an email address: a new user name is a new user.
    expect(fresh?.action).toBe("Create");
  });
  it("refuses a user name used twice in the file", () => {
    const [, second] = plan("x,x@example.com,extreviewer,", "X,y@example.com,extreviewer,");
    expect(second?.errors).toEqual(["X is already used on line 2"]);
  });
  it("gives All scan types by default, or the types named, by Platform or role name", () => {
    const [all, named, byRole, mixed, unknown] = plan(
      "a,a@example.com,extseclead,",
      "b,b@example.com,extseclead,Static;container scan",
      "c,c@example.com,extseclead,extsubmitstaticscan;EXTSUBMITCONTAINERSCAN",
      "d,d@example.com,extseclead,All;Static",
      "e,e@example.com,extseclead,Static;Quantum",
    );
    expect(give(all)).toEqual(["extseclead", "extsubmitanyscan"]);
    expect(all?.scanTypes).toBe("All");
    expect(give(named)).toEqual(["extseclead", "extsubmitstaticscan", "extsubmitcontainerscan"]);
    expect(named?.scanTypes).toBe("Static Scan, Container Scan");
    expect(give(byRole)).toEqual(give(named));
    expect(mixed?.errors).toEqual(["All can't be combined with specific scan types"]);
    expect(unknown?.errors).toEqual(["Unknown scan types: Quantum"]);
  });
  it("drops scan types when no role takes them", () => {
    const [row] = plan("a,a@example.com,extreviewer,Static");
    expect(row?.action).toBe("Create");
    expect(give(row)).toEqual(["extreviewer"]);
    expect(row?.scanTypes).toBe("");
  });
  it("leaves out roles that need a team, and names them", () => {
    const [teamAdmin, creator, withLead, onlyTeam] = plan(
      "a,a@example.com,teamAdmin;extreviewer,",
      "b,b@example.com,extcreator;extreviewer,Static",
      "c,c@example.com,extseclead;extcreator,Static",
      "d,d@example.com,teamAdmin,",
    );
    expect(teamAdmin?.action).toBe("Create");
    expect(teamAdmin?.leftOut.map((r) => r.role_name)).toEqual(["teamAdmin"]);
    expect(give(teamAdmin)).toEqual(["extreviewer"]);
    // Without Creator, nothing left takes scan types.
    expect(creator?.leftOut.map((r) => r.role_name)).toEqual(["extcreator"]);
    expect(give(creator)).toEqual(["extreviewer"]);
    expect(withLead?.leftOut).toEqual([]);
    expect(give(withLead)).toEqual(["extseclead", "extcreator", "extsubmitstaticscan"]);
    expect(onlyTeam?.action).toBe("Error");
    expect(onlyTeam?.errors).toEqual([
      "No role left: Team Admin need a team, which a CSV can't set yet",
    ]);
  });
  it("refuses unknown, Administrator, API and scan-type roles", () => {
    const [unknown, admin, api, scan] = plan(
      "a,a@example.com,notarole,",
      "b,b@example.com,extadmin,",
      "c,c@example.com,uploadapi,",
      "d,d@example.com,extreviewer;extsubmitanyscan,",
    );
    expect(unknown?.errors).toEqual(["Unknown roles: notarole"]);
    expect(admin?.errors).toEqual(["The app never gives the Administrator role"]);
    expect(api?.errors).toEqual(["The app never gives API roles: Upload API"]);
    expect(scan?.errors).toEqual(["Scan types go in the scan_types column: Any Scan"]);
  });
});

describe("user list helpers", () => {
  it("filters by search, type, status and role", () => {
    expect(filterUsers(USERS, EMPTY_FILTERS, ROLES)).toHaveLength(USERS.length);
    expect(filterUsers(USERS, { ...EMPTY_FILTERS, search: "PRIYA" }, ROLES)).toHaveLength(1);
    const api = filterUsers(USERS, { ...EMPTY_FILTERS, types: ["API"] }, ROLES);
    expect(api.every((u) => u.user_type === "API")).toBe(true);
    const inactive = filterUsers(USERS, { ...EMPTY_FILTERS, status: "inactive" }, ROLES);
    expect(inactive.every((u) => !u.active)).toBe(true);
    const admins = filterUsers(USERS, { ...EMPTY_FILTERS, role: "adminapi" }, ROLES);
    expect(admins.map((u) => u.user_name)).toEqual(["api_aautomation"]);
  });
  it("sorts both ways, with missing values first", () => {
    const asc = sortUsers(USERS, { key: "user_name", dir: "asc" });
    const desc = sortUsers(USERS, { key: "user_name", dir: "desc" });
    expect(asc[0]?.user_name).toBe(desc[desc.length - 1]?.user_name);
    expect(sortUsers(USERS, { key: "last_login", dir: "asc" })[0]?.last_login).toBeNull();
  });
  it("filters by scan type: All, or a type the user may submit", () => {
    const names = (scanType: string) =>
      filterUsers(USERS, { ...EMPTY_FILTERS, scanType }, ROLES).map((u) => u.user_name);
    const all = names("all");
    expect(all).toContain("dcohen@example.com");
    expect(all).not.toContain("kmensah@example.com");
    // Kofi has Static and Container; users with All may submit every type.
    expect(names("extsubmitstaticscan")).toEqual(
      expect.arrayContaining(["kmensah@example.com", ...all]),
    );
    expect(names("extsubmitstaticscan")).toHaveLength(all.length + 1);
    expect(names("extsubmitdynamicscan")).toEqual(all);
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

describe("roleView", () => {
  const user = (name: string) => {
    const found = USERS.find((u) => u.user_name === name);
    if (!found) throw new Error(name);
    return found;
  };
  it("shows All scan types as a setting, not as the Any Scan role", () => {
    const view = roleView(user("dcohen@example.com"), ROLES);
    expect(view.roles.map((r) => r.role_name)).toEqual(["extseclead"]);
    expect(view.scanTypes).toBe("All");
    expect(view.teamMemberships).toBeNull();
  });
  it("names specific scan types, and None when there are none", () => {
    const view = roleView(user("kmensah@example.com"), ROLES);
    expect(view.roles.map((r) => r.role_name)).toEqual(["extsubmitter"]);
    expect(view.scanTypes).toBe("Static Scan, Container Scan");
    expect(roleView(user("mwebb@example.com"), ROLES).scanTypes).toBe("None");
  });
  it("shows No Team Restriction API as an API account's team memberships", () => {
    const view = roleView(user("api_rreader"), ROLES);
    expect(view.roles.map((r) => r.role_name)).toEqual(["resultsapi"]);
    expect(view.teamMemberships).toBe("No team restrictions");
    expect(view.scanTypes).toBeNull();
    expect(roleView(user("api_cpipeline"), ROLES).teamMemberships).toBe(
      "Restricted to selected teams",
    );
  });
  it("shows the organization's own roles as ordinary roles, for now", () => {
    const view = roleView(user("hbrooks@example.com"), ROLES);
    expect(view.roles.map((r) => r.role_name)).toEqual(["extreviewer", "custom-elearningadmin"]);
  });
  it("shows a role the organization's list doesn't have as a plain role", () => {
    const u = { ...user("mwebb@example.com"), roles: [{ role_name: "x", role_description: "X" }] };
    expect(roleView(u, ROLES).roles.map((r) => r.role_description)).toEqual(["X"]);
  });
});
