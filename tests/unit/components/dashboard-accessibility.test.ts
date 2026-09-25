import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions", () => ({
  toggleRepositoryEnabledAction: vi.fn(),
  saveRepositorySettingsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/repos",
}));

import { NavSidebar } from "@/components/dashboard/nav-sidebar";
import { RepositoryToggle } from "@/components/dashboard/repository-toggle";
import { SettingsForm } from "@/components/dashboard/settings-form";

describe("dashboard accessibility", () => {
  it("names each review switch after its repository and keeps its alert region mounted", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryToggle, {
        repositoryId: "repo-1",
        repositoryName: "acme/app",
        isEnabled: false,
        canManage: true,
      }),
    );

    expect(html).toContain('aria-label="Reviews for acme/app"');
    expect(html).toMatch(/<p role="alert"[^>]*><\/p>/);
    expect(html).toContain('role="switch"');
  });

  it("keeps the save result regions mounted and labels every exclude-pattern input", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsForm, {
        repositoryId: "repo-1",
        canManage: true,
        initialSettings: {
          enabledCategories: ["BUGS"],
          minimumSeverity: "WARNING",
          excludePatterns: ["*.lock", "dist/**"],
          customInstructions: "",
        },
      }),
    );

    expect(html).toMatch(/<p role="alert"[^>]*><\/p>/);
    expect(html).toMatch(/<output[^>]*><\/output>/);
    expect(html).toMatch(/<legend[^>]*>Review Categories<\/legend>/);
    expect(html).toMatch(/<legend[^>]*>File Exclusions<\/legend>/);
    expect(html).toContain('aria-label="Exclude pattern 1"');
    expect(html).toContain('aria-label="Exclude pattern 2"');
    expect(html).toContain('aria-label="Remove exclude pattern 2"');
  });

  it("marks the current section in the navigation", () => {
    const html = renderToStaticMarkup(
      createElement(NavSidebar, {
        user: { name: "Dev", login: "dev", avatarUrl: "" },
        signOutAction: async () => undefined,
      }),
    );

    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Repositories<\/a>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
