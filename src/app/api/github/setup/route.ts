import { redirect } from "next/navigation";

export async function GET(): Promise<never> {
  redirect("/dashboard");
}
