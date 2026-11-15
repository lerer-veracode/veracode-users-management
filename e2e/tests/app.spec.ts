import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "../settings.js";

const signIn = async (page: Page, path = "/", password = E2E_PASSWORD) => {
  await page.goto(path);
  await expect(page.getByText("Un-official").first()).toBeVisible();
  await page.getByLabel("Username").fill(E2E_USER);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
};

test("backend is up", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(await res.json()).toEqual({ status: "ok" });
});

test("a wrong password is refused by the vault", async ({ page }) => {
  await signIn(page, "/", "not the password");
  await expect(page.getByRole("alert")).toHaveText("Wrong username or password.");
});

test("signs in with the vault and shows its connection", async ({ page }) => {
  await signIn(page, "/#/connections");
  await expect(page.getByRole("cell", { name: "e2e-org", exact: true })).toBeVisible();
  await expect(page.locator(".topbar-tools span", { hasText: "e2e-org" })).toBeVisible();
  await expect(page.getByText("30 days left").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: E2E_USER, exact: true })).toBeVisible();
  await expect(page.getByText("not-a-real-secret")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
});

test("the activity log records sign-ins, including refused ones", async ({ page }) => {
  await signIn(page, "/", "not the password");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.getByRole("link", { name: "Activity" }).click();
  const log = page.getByRole("region", { name: "Activity log" });
  await expect(log.getByText("app.sign_in").first()).toBeVisible();
  await page.getByRole("checkbox", { name: "Failed only" }).check();
  await expect(log.getByText("Wrong username or password.").first()).toBeVisible();
});

test("users page shows the organization's users with roles and permissions", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "All Users" })).toBeVisible();
  await expect(page.getByText("1-4 of 4")).toBeVisible();
  // Last login comes from the bulk by-role read; a user's own record doesn't have it.
  await expect(
    page.getByRole("row").filter({ hasText: "alice@example.com" }).getByText("Nov 2026"),
  ).toBeVisible();
  await page.getByRole("button", { name: "alice@example.com", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "alice@example.com" });
  await expect(dialog.getByText("Security Lead")).toBeVisible();
  await expect(dialog.getByText("Manage applications")).toBeVisible();
  // config/hidden-permissions.txt and config/hidden-roles.txt hide them.
  await expect(dialog.getByText("Manage VSA rules")).toHaveCount(0);
  await expect(dialog.getByText(/Greenlight/)).toHaveCount(0);
  await expect(dialog.getByText("Blue Team")).toBeVisible();
  // Scan types and an API account's team setting show as the Platform shows them, not as roles
  // (docs/PLAN_ROLES.md, phase 2).
  await expect(dialog.getByText("Allowed scan types").locator("+ dd")).toHaveText("All");
  await expect(dialog.getByText("Any Scan")).toHaveCount(0);
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "alice@example.com" })).not.toContainText(
    "Any Scan",
  );
  await expect(page.getByRole("row").filter({ hasText: "alice@example.com" })).not.toContainText(
    "Greenlight",
  );
  await page.getByRole("button", { name: "api_ci", exact: true }).click();
  const api = page.getByRole("dialog", { name: "api_ci" });
  await expect(api.getByText("Team memberships").locator("+ dd")).toHaveText(
    "No team restrictions",
  );
  await expect(api.getByText("No Team Restriction API")).toHaveCount(0);
  await page.mouse.click(5, 5);
  await expect(api).toBeHidden();
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByText("user.list").first()).toBeVisible();
  await expect(page.getByText("role.list").first()).toBeVisible();
});

test("adds, edits and deletes a user, and never touches an administrator", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("1-4 of 4")).toBeVisible();

  // The administrator can't be edited or deleted.
  await page.getByRole("button", { name: "boss@example.com", exact: true }).click();
  const boss = page.getByRole("dialog", { name: "boss@example.com" });
  await expect(boss.getByRole("note")).toContainText("has the Administrator role");
  await expect(boss.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(boss.getByRole("button", { name: "Delete" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Add: Administrator isn't offered.
  await page.getByRole("button", { name: "Add New User" }).click();
  const form = page.getByRole("dialog", { name: "Add New User" });
  await expect(form.getByRole("checkbox", { name: "Administrator" })).toHaveCount(0);
  // Teams are kept until a refresh; the form can read them again without closing.
  await form.getByRole("button", { name: "↻ Refresh teams" }).click();
  await expect(form.getByText("Teams refreshed.")).toBeVisible();
  await form.getByLabel("Email", { exact: true }).fill("e2e.test@example.com");
  await expect(form.getByRole("radio", { name: "Same as email" })).toBeChecked();
  await form.getByLabel("First name").fill("Test");
  await form.getByLabel("Last name").fill("Person");
  await form.getByRole("checkbox", { name: "Submitter" }).check();
  await form.getByRole("radio", { name: "All scan types" }).check();
  await form.getByRole("checkbox", { name: "Team Admin" }).check();
  await form.getByRole("button", { name: /Manages teams/ }).click();
  await form
    .getByRole("group", { name: /Manages teams/ })
    .getByLabel("Blue Team")
    .check();
  await form.getByRole("heading", { name: "Add New User" }).click();
  await form.getByRole("button", { name: "Member of teams" }).click();
  await form.getByRole("group", { name: "Member of teams" }).getByLabel("Red Team").check();
  await form.getByRole("heading", { name: "Add New User" }).click();
  await form.getByRole("button", { name: "Review" }).click();
  await expect(form.getByText("e2e-org (US)")).toBeVisible();
  await expect(form.getByRole("row", { name: "Scan types Any Scan" })).toBeVisible();
  await expect(form.getByRole("row", { name: "Manages teams Blue Team" })).toBeVisible();
  await expect(form.getByRole("row", { name: "Member of teams Red Team" })).toBeVisible();
  await form.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("Created e2e.test@example.com in e2e-org.")).toBeVisible();
  await expect(page.getByText("1-5 of 5")).toBeVisible();

  // Edit.
  await page.getByRole("button", { name: "e2e.test@example.com", exact: true }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit e2e.test@example.com" });
  // Veracode reads the managed team back as { name: "ADMIN" }: it must still show as managed.
  await expect(edit.getByRole("button", { name: /Manages teams/ })).toContainText("Blue Team");
  await edit.getByLabel("Last name").fill("Renamed");
  // Leave Red Team; Blue Team stays managed.
  await edit.getByRole("button", { name: "Member of teams" }).click();
  await edit.getByRole("group", { name: "Member of teams" }).getByLabel("Red Team").uncheck();
  await edit.getByRole("heading", { name: "Edit e2e.test@example.com" }).click();
  await edit.getByRole("button", { name: "Review" }).click();
  await expect(edit.getByRole("row", { name: "Last name Person Renamed" })).toBeVisible();
  await expect(edit.getByRole("row", { name: /^Member of teams Red Team/ })).toBeVisible();
  await expect(edit.getByRole("row", { name: /^Manages teams/ })).toHaveCount(0);
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Saved the changes to e2e.test@example.com in e2e-org."),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Test Renamed" })).toBeVisible();
  // Still managing Blue Team after the save. The details show it apart from memberships.
  await page.getByRole("button", { name: "e2e.test@example.com", exact: true }).click();
  const details = page.getByRole("dialog", { name: "e2e.test@example.com" });
  await expect(details.getByRole("definition").filter({ hasText: "Blue Team" })).toHaveCount(1);
  await expect(details.locator("dt:has-text('Manages teams') + dd")).toHaveText("Blue Team");
  await expect(details.locator("dt:has-text('Member of teams') + dd")).toHaveText("None");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(edit.getByRole("button", { name: /Manages teams/ })).toContainText("Blue Team");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("dialog", { name: "e2e.test@example.com" })
    .getByRole("button", { name: "Close", exact: true })
    .click();

  // Disable login from the Actions menu.
  await page.getByRole("button", { name: "Actions for e2e.test@example.com" }).click();
  await page.getByRole("menuitem", { name: "Disable login" }).click();
  await page
    .getByRole("dialog", { name: "Disable login for e2e.test@example.com" })
    .getByRole("button", { name: "Disable login" })
    .click();
  await expect(page.getByText("Disabled login for e2e.test@example.com in e2e-org.")).toBeVisible();

  // Delete.
  await page.getByRole("button", { name: "e2e.test@example.com", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const del = page.getByRole("dialog", { name: "Delete e2e.test@example.com" });
  await del.getByLabel(/to confirm/).fill("e2e.test@example.com");
  await del.getByRole("button", { name: "Delete user" }).click();
  await expect(page.getByText("Deleted e2e.test@example.com from e2e-org.")).toBeVisible();
  await expect(page.getByText("1-4 of 4")).toBeVisible();

  await page.getByRole("link", { name: "Activity" }).click();
  const log = page.getByRole("region", { name: "Activity log" });
  for (const action of ["user.create", "user.update", "user.delete"]) {
    await expect(log.getByText(action, { exact: true }).first()).toBeVisible();
  }
  await expect(log.getByText("delete e2e.test@example.com").first()).toBeVisible();
  // Each change keeps the user and each field from and to.
  await expect(log.getByText("Last name: Person → Renamed").first()).toBeVisible();
  await expect(log.getByText("Login: Enabled → Disabled").first()).toBeVisible();
  await expect(log.getByText("Manages teams: — → Blue Team").first()).toBeVisible();
});

test("import page previews the sample CSV against the real users", async ({ page }) => {
  await signIn(page, "/#/import");
  await page.getByLabel("CSV file").setInputFiles("../data/sample_users.csv");
  await expect(page.getByText("4 to create")).toBeVisible();
  await expect(page.getByText("1 without some roles")).toBeVisible();
  await expect(page.getByText("3 with errors")).toBeVisible();
  await expect(page.getByRole("note", { name: "Roles left out" })).toContainText(
    "tadmin: Team Admin",
  );
  await expect(
    page.getByText("jdoe@example.com is already the user name of Jane Doe, jdoe@example.com"),
  ).toBeVisible();
  await expect(page.getByText(/No role left: Submitter need a team/)).toBeVisible();
  await expect(page.getByText("Email address is required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create 4 Users" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Chosen file" })).toContainText(
    "File: sample_users.csv · 7 rows",
  );
  await page.getByRole("button", { name: "Show instructions" }).click();
  const roles = page.getByRole("list", { name: "Roles for the CSV" });
  await expect(roles).toContainText("Reviewer");
  await expect(roles).not.toContainText("Greenlight");
});
