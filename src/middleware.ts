export { auth as middleware } from "@/auth";

export const config = {
  // Every page that reads the session: only middleware can save a refreshed
  // GitHub token to the cookie, and the refresh token works once (#130).
  matcher: ["/", "/dashboard/:path*"],
  // Node rather than Edge: the access refresh calls GitHub from here and
  // shares its short-lived cache with page renders in the same process.
  runtime: "nodejs",
};
