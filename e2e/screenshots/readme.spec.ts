import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "../settings.js";

const OUT = "../docs/screenshots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });

const signIn = async (page: Page, path = "/") => {
  await page.goto(path);
  await page.getByLabel("Username").fill(E2E_USER);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
};

test("README screenshots", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("1-4 of 4")).toBeVisible();
  await expect(page.getByText("Reading last login, type and MFA from Veracode...")).toHaveCount(0);
  await shot(page, "users");

  await page.getByRole("button", { name: "alice@example.com", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "alice@example.com" })).toBeVisible();
  await shot(page, "user-details");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit alice@example.com" })).toBeVisible();
  await shot(page, "edit-user");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");

  await page.goto("/#/import");
  await page.getByLabel("CSV file").setInputFiles("../data/sample_users.csv");
  await expect(page.getByText("4 to create")).toBeVisible();
  await shot(page, "import-preview");

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByRole("region", { name: "Activity log" }).getByText("user.list").first(),
  ).toBeVisible();
  await shot(page, "activity");
});
