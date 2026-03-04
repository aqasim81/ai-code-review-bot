import { expect, test } from "@playwright/test";

test.describe("Landing page", () => {
  test("renders at / with main heading", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Automated Code Reviews/i }),
    ).toBeVisible();
  });

  test("shows install and sign-in buttons", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /Install on GitHub/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Sign in/i }).first(),
    ).toBeVisible();
  });
});

test.describe("Protected routes redirect when unauthenticated", () => {
  test("/dashboard redirects to landing page", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL("/");
    expect(page.url()).toMatch(/\/$/);
  });

  test("/dashboard/repos redirects to landing page", async ({ page }) => {
    await page.goto("/dashboard/repos");
    await page.waitForURL("/");
    expect(page.url()).toMatch(/\/$/);
  });

  test("/dashboard/reviews redirects to landing page", async ({ page }) => {
    await page.goto("/dashboard/reviews");
    await page.waitForURL("/");
    expect(page.url()).toMatch(/\/$/);
  });
});
