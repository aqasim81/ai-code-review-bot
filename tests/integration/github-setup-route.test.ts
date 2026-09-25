import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("@/auth", () => ({
  unstable_update: vi.fn(async () => {
    calls.push("update");
    return null;
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    calls.push(`redirect:${path}`);
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { GET } from "@/app/api/github/setup/route";

describe("GitHub App setup callback", () => {
  it("refreshes the session's access before redirecting to the dashboard", async () => {
    await expect(GET()).rejects.toThrow("NEXT_REDIRECT");

    expect(calls).toEqual(["update", "redirect:/dashboard"]);
  });
});
