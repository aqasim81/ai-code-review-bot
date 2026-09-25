import { redirect } from "next/navigation";
import { unstable_update } from "@/auth";

// GitHub sends the user here after installing the app. Refresh their access
// first so the new installation shows up without signing in again.
export async function GET(): Promise<never> {
  await unstable_update({});
  redirect("/dashboard");
}
