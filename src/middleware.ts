export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/dashboard/:path*"],
  // Node rather than Edge: the access refresh calls GitHub from here and
  // shares its short-lived cache with page renders in the same process.
  runtime: "nodejs",
};
