import { describe, expect, it } from "vitest";
import { ROLES, USERS } from "../mock/data";
import { SAMPLE_CSV, parseUsersCsv } from "./csv";
import { exportFileName, usersCsv } from "./exportCsv";
import { formatDateTime, fullName } from "./format";
import { csvRoles, csvScanTypes, needsTeamNote, planImport } from "./importPlan";
import { EMPTY_FILTERS, filterUsers, pageCount, pageOf, sortUsers, userStatus } from "./users";
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
    // An account whose user name isn't its email.
    const api = USERS.find((x) => x.user_name !== x.email_address);
    if (!u || !api) throw new Error("mock data");
    const [taken, upper, fresh] = plan(
      `,${u.user_name},extreviewer,`,
      `${u.user_name.toUpperCase()},new@example.com,extreviewer,`,
      `new,${api.email_address},extreviewer,`,
    );
    expect(taken?.action).toBe("Error");
    expect(taken?.errors).toEqual([
      `${u.user_name} is already the user name of ${u.first_name} ${u.last_name}, ${u.email_address}`,
    ]);
    expect(upper?.action).toBe("Error");
    // Several users may share an email address, unless it is someone's user name: a new user
    // name is a new user.
    expect(fresh?.action).toBe("Create");
  });
  it("refuses an email that is already a user name, as Veracode does", () => {
    const u = USERS[1];
    if (!u) throw new Error("mock data");
    const [taken, earlier, refused] = plan(
      `other,${u.user_name},extreviewer,`,
      "x@example.com,x@example.com,extreviewer,",
      "y,x@example.com,extreviewer,",
    );
    expect(taken?.errors).toEqual([
      `Veracode refuses this email: it is the user name of ${u.first_name} ${u.last_name}`,
    ]);
    expect(earlier?.action).toBe("Create");
    expect(refused?.errors).toEqual(["Veracode refuses this email: it is the user name on line 3"]);
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
  it("takes roles by their Platform names or role names, ignoring case", () => {
    const [byName, mixed] = plan(
      "a,a@example.com,Security Lead;reviewer,",
      "b,b@example.com,EXTSECLEAD;Creator,Static",
    );
    expect(give(byName)).toEqual(["extseclead", "extreviewer", "extsubmitanyscan"]);
    expect(give(mixed)).toEqual(["extseclead", "extcreator", "extsubmitstaticscan"]);
  });
  it("lists the roles and scan types a CSV can use", () => {
    const roles = csvRoles(ROLES).map((r) => r.role_description);
    expect(roles).toContain("Security Lead");
    expect(roles).not.toContain("Administrator");
    expect(roles).not.toContain("Any Scan");
    expect(roles).not.toContain("Upload API");
    expect(roles).not.toContain("No Team Restriction API");
    expect(roles).toEqual([...roles].sort((a, b) => a.localeCompare(b)));
    expect(csvScanTypes(ROLES).map((r) => r.role_description)).toEqual([
      "Container Scan",
      "Dynamic Scan",
      "Static Scan",
    ]);
    const note = (name: string) => {
      const role = ROLES.find((r) => r.role_name === name);
      if (!role) throw new Error(`mock role ${name}`);
      return needsTeamNote(role);
    };
    expect(note("teamAdmin")).toBe("left out: needs a team");
    expect(note("extcreator")).toBe("left out without Security Lead: needs a team");
    expect(note("extreviewer")).toBe("");
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
      "No role left: Team Admin needs a team, which a CSV can't set yet",
    ]);
  });
  it("accepts every row of the sample offered for download", () => {
    const rows = planImport(parseUsersCsv(SAMPLE_CSV).rows, USERS, ROLES);
    expect(rows.map((p) => [p.user_name, p.action, p.scanTypes])).toEqual([
      ["jane.doe@example.com", "Create", "All"],
      ["asmith", "Create", ""],
      ["mlopez", "Create", "Static Scan, Container Scan"],
    ]);
    expect(rows.every((p) => p.leftOut.length === 0)).toBe(true);
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

describe("usersCsv", () => {
  const byName = (name: string) => {
    const u = USERS.find((x) => x.user_name === name);
    if (!u) throw new Error(`mock user ${name}`);
    return u;
  };

  it("writes the users in the import's format, email first", () => {
    const users = ["dcohen@example.com", "kmensah@example.com", "api_rreader", "mwebb@example.com"];
    const lines = usersCsv(users.map(byName), ROLES).trimEnd().split("\n");
    expect(lines).toEqual([
      "email_address,user_name,first_name,last_name,roles,scan_types",
      "dcohen@example.com,dcohen@example.com,Dana,Cohen,Security Lead,All",
      "kmensah@example.com,kmensah@example.com,Kofi,Mensah,Submitter,Static Scan;Container Scan",
      "rreader@example.com,api_rreader,Results,Reader,Results API,",
      "mwebb@example.com,mwebb@example.com,Marcus,Webb,Reviewer,",
    ]);
  });
  it("quotes commas and quotes, and keeps a cell from running as a formula", () => {
    const u = { ...byName("mwebb@example.com"), first_name: 'Jo, "J"', last_name: "=SUM(A1)" };
    const [, line] = usersCsv([u], ROLES).split("\n");
    expect(line).toBe('mwebb@example.com,mwebb@example.com,"Jo, ""J""",\'=SUM(A1),Reviewer,');
  });
  it("reads back with the import's parser, every row already a user", () => {
    const users = USERS.filter((u) => u.user_type === "UI").slice(0, 5);
    const rows = parseUsersCsv(usersCsv(users, ROLES)).rows;
    expect(rows.map((r) => r.user_name)).toEqual(users.map((u) => u.user_name));
    const plan = planImport(rows, USERS, ROLES);
    expect(plan.every((p) => p.errors.some((e) => e.includes("is already the user name of")))).toBe(
      true,
    );
  });
  it("names the file after the connection and the day", () => {
    expect(exportFileName("acme", new Date(2026, 10, 5))).toBe("users-acme-2026-11-05.csv");
    expect(exportFileName("My Org / EU", new Date(2026, 0, 15))).toBe(
      "users-My-Org-EU-2026-01-15.csv",
    );
    expect(exportFileName("///", new Date(2026, 0, 15))).toBe("users-users-2026-01-15.csv");
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
  it("tells an active user whose login is disabled apart from an active one", () => {
    expect(userStatus({ active: true, login_enabled: true })).toBe("active");
    expect(userStatus({ active: true, login_enabled: false })).toBe("login_disabled");
    expect(userStatus({ active: false, login_enabled: false })).toBe("inactive");
    expect(userStatus({ active: false, login_enabled: true })).toBe("inactive");
    const [first, second] = USERS;
    if (!first || !second) throw new Error("mock data");
    const users = [first, { ...second, active: true, login_enabled: false }];
    const only = (status: "active" | "login_disabled") =>
      filterUsers(users, { ...EMPTY_FILTERS, status }, ROLES).map((u) => u.user_name);
    expect(only("login_disabled")).toEqual([second.user_name]);
    expect(only("active")).not.toContain(second.user_name);
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
