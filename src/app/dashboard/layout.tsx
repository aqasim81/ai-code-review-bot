import { redirect } from "next/navigation";
import { getSession, signOut } from "@/auth";
import { NavSidebar } from "@/components/dashboard/nav-sidebar";
import { MAX_SESSION_REPOSITORIES } from "@/lib/github/user-installations";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/");
  }

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <div className="flex h-screen">
      <NavSidebar
        user={{
          name: session.user.name,
          login: session.user.login,
          avatarUrl: session.user.avatarUrl,
        }}
        signOutAction={handleSignOut}
      />
      <main className="flex-1 overflow-y-auto p-8">
        {session.accessPending && (
          <p
            role="alert"
            className="mb-6 rounded-md border p-3 text-sm text-destructive"
          >
            Could not refresh your GitHub access. Retrying in a few seconds;
            until then, recently added installations or repositories may be
            missing.
          </p>
        )}
        {session.access.truncated && (
          <p className="mb-6 rounded-md border p-3 text-sm text-muted-foreground">
            You have access to more repositories than the dashboard can show at
            once. Only the first {MAX_SESSION_REPOSITORIES} are listed.
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
