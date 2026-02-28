import { createRequire } from "node:module";
import path from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { AstParseError } from "@/types/errors";
import type { Result } from "@/types/results";
import { err, ok } from "@/types/results";
import type {
  AstFileContext,
  AstImport,
  AstScope,
  ScopeType,
  SupportedLanguage,
} from "@/types/review";

const require = createRequire(import.meta.url);

let initialized = false;
let parserInstance: Parser | null = null;
const loadedLanguages = new Map<string, Language>();

const GRAMMAR_PACKAGE_MAP: Record<
  SupportedLanguage,
  { packageName: string; wasmFile: string }
> = {
  typescript: {
    packageName: "tree-sitter-typescript",
    wasmFile: "tree-sitter-tsx.wasm",
  },
  javascript: {
    packageName: "tree-sitter-javascript",
    wasmFile: "tree-sitter-javascript.wasm",
  },
  python: {
    packageName: "tree-sitter-python",
    wasmFile: "tree-sitter-python.wasm",
  },
  go: { packageName: "tree-sitter-go", wasmFile: "tree-sitter-go.wasm" },
  rust: {
    packageName: "tree-sitter-rust",
    wasmFile: "tree-sitter-rust.wasm",
  },
  java: {
    packageName: "tree-sitter-java",
    wasmFile: "tree-sitter-java.wasm",
  },
};

const JS_TS_SCOPE_TYPES: Record<string, ScopeType> = {
  function_declaration: "function",
  method_definition: "method",
  class_declaration: "class",
  arrow_function: "function",
  function_expression: "function",
};

const JS_TS_IMPORT_TYPES = ["import_statement"];

const SCOPE_NODE_TYPES: Record<SupportedLanguage, Record<string, ScopeType>> = {
  typescript: JS_TS_SCOPE_TYPES,
  javascript: JS_TS_SCOPE_TYPES,
  python: {
    function_definition: "function",
    class_definition: "class",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
  },
  rust: {
    function_item: "function",
    impl_item: "class",
  },
  java: {
    method_declaration: "method",
    class_declaration: "class",
    constructor_declaration: "method",
  },
};

const IMPORT_NODE_TYPES: Record<SupportedLanguage, string[]> = {
  typescript: JS_TS_IMPORT_TYPES,
  javascript: JS_TS_IMPORT_TYPES,
  python: ["import_statement", "import_from_statement"],
  go: ["import_declaration"],
  rust: ["use_declaration"],
  java: ["import_declaration"],
};

export async function initializeAstParser(): Promise<
  Result<void, AstParseError>
> {
  if (initialized) {
    return ok(undefined);
  }

  try {
    await Parser.init({
      locateFile(scriptName: string) {
        return path.join(
          process.cwd(),
          "node_modules",
          "web-tree-sitter",
          scriptName,
        );
      },
    });
    parserInstance = new Parser();
    initialized = true;
    return ok(undefined);
  } catch {
    return err("AST_INIT_FAILED");
  }
}

export async function parseFileAst(
  fileContent: string,
  language: SupportedLanguage,
  filePath: string,
): Promise<Result<AstFileContext, AstParseError>> {
  if (!initialized || parserInstance === null) {
    const initResult = await initializeAstParser();
    if (!initResult.success) {
      return initResult;
    }
  }

  if (parserInstance === null) {
    return err("AST_INIT_FAILED");
  }

  const languageObj = await loadLanguageGrammar(language);
  if (languageObj === null) {
    return err("AST_LANGUAGE_NOT_SUPPORTED");
  }

  let tree: ReturnType<Parser["parse"]> = null;
  try {
    parserInstance.setLanguage(languageObj);
    tree = parserInstance.parse(fileContent);

    if (tree === null) {
      return err("AST_PARSE_FAILED");
    }

    const rootNode = tree.rootNode;
    const scopes = extractScopes(rootNode, language);
    const imports = extractImports(rootNode, language);

    return ok({ filePath, language, scopes, imports });
  } catch {
    return err("AST_PARSE_FAILED");
  } finally {
    tree?.delete();
  }
}

async function loadLanguageGrammar(
  language: SupportedLanguage,
): Promise<Language | null> {
  const grammarInfo = GRAMMAR_PACKAGE_MAP[language];
  const cacheKey = grammarInfo.wasmFile;

  const cached = loadedLanguages.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const packageJsonPath = require.resolve(
      `${grammarInfo.packageName}/package.json`,
    );
    const packageDir = path.dirname(packageJsonPath);
    const grammarPath = path.join(packageDir, grammarInfo.wasmFile);
    const lang = await Language.load(grammarPath);
    loadedLanguages.set(cacheKey, lang);
    return lang;
  } catch {
    return null;
  }
}

function extractScopes(
  rootNode: Node,
  language: SupportedLanguage,
): AstScope[] {
  const scopeTypes = SCOPE_NODE_TYPES[language];
  const nodeTypeNames = Object.keys(scopeTypes);
  const descendants = rootNode.descendantsOfType(nodeTypeNames);
  const scopes: AstScope[] = [];

  for (const node of descendants) {
    const scopeType = scopeTypes[node.type];
    if (scopeType === undefined) {
      continue;
    }

    const name = resolveScopeName(node, language);
    scopes.push({
      type: scopeType,
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  }

  return scopes;
}

function resolveScopeName(node: Node, language: SupportedLanguage): string {
  const nameNode = node.childForFieldName("name");
  if (nameNode !== null) {
    return nameNode.text;
  }

  if (language === "typescript" || language === "javascript") {
    return resolveAnonymousScopeName(node);
  }

  if (language === "rust" && node.type === "impl_item") {
    const typeNode = node.childForFieldName("type");
    if (typeNode !== null) {
      return typeNode.text;
    }
  }

  return "<anonymous>";
}

function resolveAnonymousScopeName(node: Node): string {
  if (node.type === "arrow_function" || node.type === "function_expression") {
    const parent = node.parent;
    if (parent !== null && parent.type === "variable_declarator") {
      const varName = parent.childForFieldName("name");
      if (varName !== null) {
        return varName.text;
      }
    }
    if (parent !== null && parent.type === "pair") {
      const keyNode = parent.childForFieldName("key");
      if (keyNode !== null) {
        return keyNode.text;
      }
    }
  }
  return "<anonymous>";
}

function extractImports(
  rootNode: Node,
  language: SupportedLanguage,
): AstImport[] {
  const importTypes = IMPORT_NODE_TYPES[language];
  const descendants = rootNode.descendantsOfType(importTypes);
  const imports: AstImport[] = [];

  for (const node of descendants) {
    const parsed = parseImportNode(node, language);
    if (parsed !== null) {
      imports.push(parsed);
    }
  }

  return imports;
}

function parseImportNode(
  node: Node,
  language: SupportedLanguage,
): AstImport | null {
  if (language === "typescript" || language === "javascript") {
    return parseJsImport(node);
  }
  if (language === "python") {
    return parsePythonImport(node);
  }
  return parseGenericImport(node);
}

function parseJsImport(node: Node): AstImport | null {
  const sourceNode = node.childForFieldName("source");
  if (sourceNode === null) {
    return null;
  }

  const source = sourceNode.text.replace(/['"]/g, "");
  const specifiers: string[] = [];
  let isDefault = false;

  for (const child of node.namedChildren) {
    if (child.type === "import_clause") {
      for (const clauseChild of child.namedChildren) {
        if (clauseChild.type === "identifier") {
          isDefault = true;
          specifiers.push(clauseChild.text);
        } else if (clauseChild.type === "named_imports") {
          for (const specNode of clauseChild.namedChildren) {
            if (specNode.type === "import_specifier") {
              const nameNode = specNode.childForFieldName("name");
              if (nameNode !== null) {
                specifiers.push(nameNode.text);
              }
            }
          }
        } else if (clauseChild.type === "namespace_import") {
          const nameNode = clauseChild.childForFieldName("name");
          if (nameNode !== null) {
            specifiers.push(`* as ${nameNode.text}`);
          }
        }
      }
    }
  }

  return { source, specifiers, isDefault };
}

function parsePythonImport(node: Node): AstImport | null {
  if (node.type === "import_from_statement") {
    const moduleNode = node.childForFieldName("module_name");
    const source = moduleNode !== null ? moduleNode.text : "<unknown>";
    const specifiers: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === "dotted_name" && child !== moduleNode) {
        specifiers.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        if (nameNode !== null) {
          specifiers.push(nameNode.text);
        }
      }
    }

    return { source, specifiers, isDefault: false };
  }

  if (node.type === "import_statement") {
    const firstNamed = node.namedChildren[0];
    const source = firstNamed !== undefined ? firstNamed.text : "<unknown>";
    return { source, specifiers: [source], isDefault: true };
  }

  return null;
}

function parseGenericImport(node: Node): AstImport | null {
  const text = node.text.trim();
  const source = text
    .replace(/^(import|use)\s+/, "")
    .replace(/;$/, "")
    .trim();
  return { source, specifiers: [], isDefault: false };
}
