"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface NavSidebarProps {
  readonly user: {
    readonly name?: string | null;
    readonly login: string;
    readonly avatarUrl: string;
  };
  readonly signOutAction: () => Promise<void>;
}

const navItems = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/repos", label: "Repositories" },
  { href: "/dashboard/reviews", label: "Reviews" },
] as const;

export function NavSidebar({ user, signOutAction }: NavSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
          CR
        </div>
        <span className="font-semibold text-sm">Code Review</span>
      </div>

      <Separator />

      <nav className="flex-1 px-3 py-4">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Separator />

      <div className="flex items-center gap-3 px-4 py-4">
        <Avatar className="h-8 w-8">
          <AvatarImage src={user.avatarUrl} alt={user.name ?? user.login} />
          <AvatarFallback>
            {(user.name ?? user.login).slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {user.name ?? user.login}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            @{user.login}
          </p>
        </div>
        <form action={signOutAction}>
          <Button variant="ghost" size="sm" type="submit">
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );
}
