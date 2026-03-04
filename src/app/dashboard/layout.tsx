import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { NavSidebar } from "@/components/dashboard/nav-sidebar";

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
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
