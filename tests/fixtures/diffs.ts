/**
 * Diff string fixtures for testing parseUnifiedDiff().
 * Each constant is a raw unified diff string as returned by the GitHub API.
 */

export const SINGLE_FILE_TYPESCRIPT_DIFF = `diff --git a/src/lib/utils.ts b/src/lib/utils.ts
index abc1234..def5678 100644
--- a/src/lib/utils.ts
+++ b/src/lib/utils.ts
@@ -1,4 +1,6 @@
 import { clsx } from "clsx";
+import { twMerge } from "tailwind-merge";
+
 export function cn(...inputs: string[]) {
-  return clsx(inputs);
+  return twMerge(clsx(inputs));
 }
`;

export const MULTI_FILE_DIFF = `diff --git a/src/lib/auth.ts b/src/lib/auth.ts
index abc1234..def5678 100644
--- a/src/lib/auth.ts
+++ b/src/lib/auth.ts
@@ -1,3 +1,5 @@
 import { env } from "@/lib/env";
+import { logger } from "@/lib/logger";
+
 export function validateToken(token: string): boolean {
   return token.length > 0;
 }
diff --git a/src/lib/handler.py b/src/lib/handler.py
index 111aaa..222bbb 100644
--- a/src/lib/handler.py
+++ b/src/lib/handler.py
@@ -1,2 +1,4 @@
 def handle_request(req):
+    if req is None:
+        raise ValueError("req cannot be None")
     return req.body
diff --git a/src/main.go b/src/main.go
index 333ccc..444ddd 100644
--- a/src/main.go
+++ b/src/main.go
@@ -1,3 +1,4 @@
 package main

+import "fmt"
 func main() {}
`;

export const BINARY_FILE_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
index abc1234..def5678 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/lib/code.ts b/src/lib/code.ts
index aaa1111..bbb2222 100644
--- a/src/lib/code.ts
+++ b/src/lib/code.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export { a };
`;

export const DELETED_FILE_DIFF = `diff --git a/src/lib/old-module.ts b/src/lib/old-module.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/lib/old-module.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-export function oldFunction(): void {
-  console.log("deprecated");
-}
-
-export const OLD_CONSTANT = 42;
`;

export const RENAMED_FILE_DIFF = `diff --git a/src/lib/old-name.ts b/src/lib/new-name.ts
similarity index 90%
rename from src/lib/old-name.ts
rename to src/lib/new-name.ts
index abc1234..def5678 100644
--- a/src/lib/old-name.ts
+++ b/src/lib/new-name.ts
@@ -1,3 +1,3 @@
-export function oldFunction(): string {
+export function newFunction(): string {
   return "hello";
 }
`;

export const NEW_FILE_DIFF = `diff --git a/src/lib/brand-new.ts b/src/lib/brand-new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/lib/brand-new.ts
@@ -0,0 +1,5 @@
+export interface Config {
+  readonly port: number;
+  readonly host: string;
+  readonly debug: boolean;
+}
`;

export const NON_REVIEWABLE_FILES_DIFF = `diff --git a/package-lock.json b/package-lock.json
index abc1234..def5678 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0"
+  "version": "1.0.1"
 }
diff --git a/dist/bundle.min.js b/dist/bundle.min.js
index 111aaa..222bbb 100644
--- a/dist/bundle.min.js
+++ b/dist/bundle.min.js
@@ -1 +1 @@
-var a=1;
+var a=2;
diff --git a/assets/icon.png b/assets/icon.png
index 333ccc..444ddd 100644
Binary files a/assets/icon.png and b/assets/icon.png differ
`;

export const MULTI_HUNK_DIFF = `diff --git a/src/lib/service.ts b/src/lib/service.ts
index abc1234..def5678 100644
--- a/src/lib/service.ts
+++ b/src/lib/service.ts
@@ -1,5 +1,6 @@
 import { db } from "./db";
+import { logger } from "./logger";

 export function getUser(id: string) {
   return db.user.findUnique({ where: { id } });
@@ -10,4 +11,5 @@ export function getUser(id: string) {
 export function deleteUser(id: string) {
   return db.user.delete({ where: { id } });
+  logger.info("User deleted", { id });
 }
`;

export const NO_NEWLINE_AT_END_DIFF = `diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,3 @@
 export const config = {
-  port: 3000,
+  port: 8080,
 };
\\ No newline at end of file
`;

export const SECURITY_SENSITIVE_DIFF = `diff --git a/src/lib/auth/token-validator.ts b/src/lib/auth/token-validator.ts
index abc1234..def5678 100644
--- a/src/lib/auth/token-validator.ts
+++ b/src/lib/auth/token-validator.ts
@@ -1,3 +1,5 @@
 export function validateToken(token: string): boolean {
+  if (token === "") return false;
+  if (token.length < 32) return false;
   return token.startsWith("sk_");
 }
`;

export const EMPTY_DIFF = "";

export const WHITESPACE_ONLY_DIFF = "   \n  \n  ";

export const LARGE_DIFF_MANY_FILES = Array.from(
  { length: 10 },
  (_, i) =>
    `diff --git a/src/lib/module-${i}.ts b/src/lib/module-${i}.ts
index abc1234..def5678 100644
--- a/src/lib/module-${i}.ts
+++ b/src/lib/module-${i}.ts
@@ -1,2 +1,3 @@
 export const value${i} = ${i};
+export const added${i} = ${i + 100};
 export default value${i};
`,
).join("");
