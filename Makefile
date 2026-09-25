# Single gate: `make verify`, wrapping the pnpm scripts so hooks, CI and Claude all call the same thing.
.PHONY: setup test lint typecheck verify run doctor
setup:
	pnpm install --frozen-lockfile
test:
	pnpm test
lint:
	pnpm lint
typecheck:
	pnpm type-check
verify: ## uses the "validate" script if package.json defines one
	@if jq -e '.scripts.validate' package.json >/dev/null; then pnpm run validate; else $(MAKE) lint typecheck test; fi
	@echo "VERIFY OK"
run:
	pnpm dev
doctor:
	@for t in node pnpm jq git lefthook gitleaks; do command -v $$t >/dev/null && echo "ok  $$t" || echo "MISSING $$t"; done
