import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";

export default async function LandingPage() {
  const session = await auth();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
            CR
          </div>
          <span className="font-semibold">Code Review</span>
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/dashboard" });
          }}
        >
          <Button variant="outline" size="sm" type="submit">
            Sign in
          </Button>
        </form>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="max-w-2xl text-center space-y-6">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Automated Code Reviews
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Get instant, intelligent feedback on every pull request. AST-aware
            analysis catches security issues, bugs, and anti-patterns before
            they reach production.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
            <Button size="lg" asChild>
              <a
                href={`https://github.com/apps/${process.env.GITHUB_APP_SLUG ?? "code-review-bot"}/installations/new`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Install on GitHub
              </a>
            </Button>
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/dashboard" });
              }}
            >
              <Button variant="outline" size="lg" type="submit">
                Sign in to Dashboard
              </Button>
            </form>
          </div>
        </div>

        <div className="grid gap-8 sm:grid-cols-3 mt-20 max-w-4xl w-full">
          <div className="text-center space-y-2">
            <h3 className="font-semibold">AST-Aware Analysis</h3>
            <p className="text-sm text-muted-foreground">
              Understands code structure with tree-sitter parsing for
              TypeScript, Python, Go, Rust, Java, and JavaScript.
            </p>
          </div>
          <div className="text-center space-y-2">
            <h3 className="font-semibold">Inline PR Comments</h3>
            <p className="text-sm text-muted-foreground">
              Posts contextual review comments directly on the lines that
              matter, with severity levels and fix suggestions.
            </p>
          </div>
          <div className="text-center space-y-2">
            <h3 className="font-semibold">Delta Reviews</h3>
            <p className="text-sm text-muted-foreground">
              Only reviews changed files on push events, avoiding duplicate
              comments on already-reviewed code.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t px-6 py-4 text-center text-sm text-muted-foreground">
        Automated code review powered by AST parsing and LLM analysis.
      </footer>
    </div>
  );
}
