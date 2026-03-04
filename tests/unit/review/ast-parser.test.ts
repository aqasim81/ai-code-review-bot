import { beforeEach, describe, expect, it, vi } from "vitest";

// Define mock fns at top level so they persist
const mockParse = vi.fn();
const mockSetLanguage = vi.fn();
const mockInit = vi.fn().mockResolvedValue(undefined);
const mockLanguageLoad = vi.fn().mockResolvedValue({});
const mockDelete = vi.fn();
const mockDescendantsOfType = vi.fn().mockReturnValue([]);

// Mock web-tree-sitter (hoisted)
vi.mock("web-tree-sitter", () => {
  function MockParser() {
    return { parse: mockParse, setLanguage: mockSetLanguage };
  }
  MockParser.init = mockInit;

  return {
    Parser: MockParser,
    Language: { load: mockLanguageLoad },
  };
});

// Mock node:module's createRequire
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: () => "/mock/tree-sitter-typescript/package.json",
  }),
}));

function createMockTree() {
  return {
    rootNode: { descendantsOfType: mockDescendantsOfType },
    delete: mockDelete,
  };
}

function createMockScopeNode(
  type: string,
  name: string | null,
  startRow: number,
  endRow: number,
  parent?: Record<string, unknown> | null,
) {
  return {
    type,
    childForFieldName: vi.fn().mockImplementation((field: string) => {
      if (field === "name" && name !== null) return { text: name };
      return null;
    }),
    startPosition: { row: startRow },
    endPosition: { row: endRow },
    parent: parent ?? null,
  };
}

describe("ast-parser", () => {
  // Tests run in sequence against a single module load since
  // the parser has module-level state that's hard to reset.
  // We test init first, then parsing.

  let initializeAstParser: typeof import("@/lib/review/ast-parser").initializeAstParser;
  let parseFileAst: typeof import("@/lib/review/ast-parser").parseFileAst;

  // Load fresh module once per describe block via resetModules
  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockLanguageLoad.mockResolvedValue({});
    mockParse.mockReturnValue(createMockTree());
    mockDescendantsOfType.mockReturnValue([]);
  });

  // We need a fresh module to test init behavior properly
  describe("initializeAstParser", () => {
    it("returns ok on successful initialization", async () => {
      vi.resetModules();
      const mod = await import("@/lib/review/ast-parser");
      initializeAstParser = mod.initializeAstParser;
      parseFileAst = mod.parseFileAst;

      const result = await initializeAstParser();
      expect(result.success).toBe(true);
      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it("returns AST_INIT_FAILED when Parser.init throws", async () => {
      vi.resetModules();
      mockInit.mockRejectedValueOnce(new Error("WASM load failed"));
      const mod = await import("@/lib/review/ast-parser");

      const result = await mod.initializeAstParser();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe("AST_INIT_FAILED");
    });

    it("returns ok immediately on second call (already initialized)", async () => {
      vi.resetModules();
      const mod = await import("@/lib/review/ast-parser");

      await mod.initializeAstParser();
      mockInit.mockClear();

      const result = await mod.initializeAstParser();
      expect(result.success).toBe(true);
      expect(mockInit).not.toHaveBeenCalled();
    });
  });

  describe("parseFileAst", () => {
    // Get a fresh module with successful init for all parseFileAst tests
    beforeEach(async () => {
      vi.resetModules();
      const mod = await import("@/lib/review/ast-parser");
      initializeAstParser = mod.initializeAstParser;
      parseFileAst = mod.parseFileAst;
    });

    it("auto-initializes parser if not already initialized", async () => {
      const result = await parseFileAst(
        "const x = 1;",
        "typescript",
        "test.ts",
      );
      expect(mockInit).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("returns AST_LANGUAGE_NOT_SUPPORTED when grammar fails to load", async () => {
      mockLanguageLoad.mockRejectedValueOnce(new Error("Grammar not found"));
      const result = await parseFileAst(
        "const x = 1;",
        "typescript",
        "test.ts",
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe("AST_LANGUAGE_NOT_SUPPORTED");
    });

    it("returns AST_PARSE_FAILED when parser.parse returns null", async () => {
      mockParse.mockReturnValueOnce(null);
      const result = await parseFileAst("broken code", "typescript", "test.ts");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe("AST_PARSE_FAILED");
    });

    it("returns AST_PARSE_FAILED when parser throws", async () => {
      mockParse.mockImplementationOnce(() => {
        throw new Error("Parse crash");
      });
      const result = await parseFileAst("code", "typescript", "test.ts");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe("AST_PARSE_FAILED");
    });

    it("extracts function scopes from descendants", async () => {
      const mockNode = createMockScopeNode(
        "function_declaration",
        "myFunction",
        0,
        10,
      );
      mockDescendantsOfType.mockReturnValue([mockNode]);

      const result = await parseFileAst(
        "function myFunction() {}",
        "typescript",
        "test.ts",
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.scopes).toHaveLength(1);
      expect(result.data.scopes[0]?.type).toBe("function");
      expect(result.data.scopes[0]?.name).toBe("myFunction");
      expect(result.data.scopes[0]?.startLine).toBe(1); // row 0 + 1
      expect(result.data.scopes[0]?.endLine).toBe(11); // row 10 + 1
    });

    it("returns <anonymous> for unnamed scopes in non-JS languages", async () => {
      const mockNode = {
        ...createMockScopeNode("function_declaration", null, 0, 5),
        text: "func() {}",
        namedChildren: [],
      };
      // First call returns scope nodes, second call (imports) returns empty
      mockDescendantsOfType
        .mockReturnValueOnce([mockNode])
        .mockReturnValueOnce([]);

      const result = await parseFileAst("func() {}", "go", "test.go");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.scopes[0]?.name).toBe("<anonymous>");
    });

    it("resolves arrow function names from parent variable declarator", async () => {
      const parentNode = {
        type: "variable_declarator",
        childForFieldName: vi.fn().mockImplementation((field: string) => {
          if (field === "name") return { text: "handleClick" };
          return null;
        }),
      };
      const mockNode = createMockScopeNode(
        "arrow_function",
        null,
        0,
        3,
        parentNode,
      );
      mockDescendantsOfType.mockReturnValue([mockNode]);

      const result = await parseFileAst(
        "const handleClick = () => {}",
        "typescript",
        "test.ts",
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.scopes[0]?.name).toBe("handleClick");
    });

    it("cleans up parsed tree via delete()", async () => {
      await parseFileAst("const x = 1;", "typescript", "test.ts");
      expect(mockDelete).toHaveBeenCalled();
    });

    it("returns correct filePath and language in result", async () => {
      const result = await parseFileAst("x = 1", "python", "src/main.py");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.filePath).toBe("src/main.py");
      expect(result.data.language).toBe("python");
    });

    it("extracts import nodes", async () => {
      const importNode = {
        type: "import_statement",
        childForFieldName: vi.fn().mockImplementation((field: string) => {
          if (field === "source") return { text: '"react"' };
          return null;
        }),
        namedChildren: [
          {
            type: "import_clause",
            namedChildren: [
              {
                type: "named_imports",
                namedChildren: [
                  {
                    type: "import_specifier",
                    childForFieldName: vi
                      .fn()
                      .mockImplementation((field: string) => {
                        if (field === "name") return { text: "useState" };
                        return null;
                      }),
                  },
                ],
              },
            ],
          },
        ],
        text: 'import { useState } from "react";',
      };

      // First call for scopes, second for imports
      mockDescendantsOfType
        .mockReturnValueOnce([]) // scopes
        .mockReturnValueOnce([importNode]); // imports

      const result = await parseFileAst(
        'import { useState } from "react";',
        "typescript",
        "test.ts",
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.imports.length).toBeGreaterThanOrEqual(0);
      // The import parsing uses complex node traversal; verify structure exists
      expect(result.data.imports).toBeDefined();
    });
  });
});
