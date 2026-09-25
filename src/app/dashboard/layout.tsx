import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { NavSidebar } from "@/components/dashboard/nav-sidebar";
import { MAX_SESSION_REPOSITORIES } from "@/lib/github/user-installations";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

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
