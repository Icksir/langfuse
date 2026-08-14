/**
 * Validation of a JSON schema against the subset of JSON Schema Draft 2020-12
 * that constrained decoding providers accept.
 *
 * Findings are warnings only and never block saving: prompts are provider
 * agnostic and a schema outside the subset is still valid JSON Schema for
 * everyone else. The messages are explicit about the consequence because the
 * failure mode is not a silent degradation — Amazon Bedrock rejects the request.
 */

export type SubsetIssue = { path: string; message: string };

/**
 * A subset issue that the visual schema builder cannot represent. Keeping the
 * flag internal keeps `SubsetIssue` a plain rendering contract; consumers ask
 * `isVisuallyEditable` instead of reasoning about individual issues.
 */
type InternalIssue = SubsetIssue & { blocksVisualEditor?: boolean };

const CONSEQUENCE =
  "Amazon Bedrock rejects schemas outside the constrained decoding subset with a 400 instead of ignoring the unsupported part.";

/** Out of the subset, but the visual builder can still round-trip the schema. */
const OUT_OF_SUBSET_KEYWORDS = [
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
] as const;

/** Out of the subset and not representable in the visual builder. */
const UNSUPPORTED_COMPOSITION_KEYWORDS = [
  "allOf",
  "if",
  "then",
  "else",
] as const;

const ROOT_PATH = "#";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON Pointer token escaping, so property names with `/` or `~` stay addressable. */
const escapeToken = (token: string) =>
  token.replace(/~/g, "~0").replace(/\//g, "~1");

const childPath = (path: string, ...tokens: (string | number)[]) =>
  [path, ...tokens.map((token) => escapeToken(String(token)))].join("/");

/** Matches `{ "type": "null" }` — the null branch of the nullable `anyOf` pattern. */
const isNullBranch = (branch: unknown) =>
  isRecord(branch) &&
  Object.keys(branch).length === 1 &&
  branch.type === "null";

/**
 * Returns the index of the non-null branch when `anyOf` is the documented
 * nullable pattern (exactly one value branch plus a bare null branch), or `null`
 * for any other union. Exported so the visual builder and this validator agree
 * on what "nullable" means.
 */
export function nullableBranchIndex(anyOf: unknown[]): number | null {
  if (anyOf.length !== 2) return null;
  const nullIndex = anyOf.findIndex(isNullBranch);
  if (nullIndex === -1) return null;

  const valueIndex = nullIndex === 0 ? 1 : 0;
  return isRecord(anyOf[valueIndex]) && !isNullBranch(anyOf[valueIndex])
    ? valueIndex
    : null;
}

type RefTarget = { kind: "root" } | { kind: "def"; name: string };

/**
 * Resolves the pointers the subset allows: the document root and a top-level
 * `$defs` entry. Anything else (external URL, pointer into `properties`,
 * draft-07 `definitions`) is unsupported and returns `null`.
 */
function parseRef(ref: string): RefTarget | null {
  if (ref === "#" || ref === "#/") return { kind: "root" };

  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  return match ? { kind: "def", name: match[1].replace(/~1/g, "/") } : null;
}

function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") out.push(value);
    else collectRefs(value, out);
  }
}

/**
 * Walks the `$ref` graph starting at `name` to see whether it reaches itself.
 * Cycle detection uses reachability rather than a visited set on the main walk,
 * so a `$def` referenced by several siblings is reuse, not recursion.
 */
function isRecursiveDef(
  defs: Record<string, unknown>,
  origin: string,
): boolean {
  const visited = new Set<string>();
  const queue = [origin];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const refs: string[] = [];
    collectRefs(defs[current], refs);

    for (const ref of refs) {
      const target = parseRef(ref);
      if (!target || target.kind === "root") continue;
      // Reachability from `origin` back to `origin`, not to whichever
      // definition the walk is currently expanding.
      if (target.name === origin) return true;
      if (visited.has(target.name)) continue;

      visited.add(target.name);
      queue.push(target.name);
    }
  }

  return false;
}

type WalkContext = {
  defs: Record<string, unknown>;
  issues: InternalIssue[];
};

function checkRef(ref: string, path: string, ctx: WalkContext): void {
  const refPath = childPath(path, "$ref");
  const target = parseRef(ref);

  if (!target) {
    ctx.issues.push({
      path: refPath,
      message: `\`$ref\` only supports pointers to a top-level \`$defs\` entry, but this one is \`${ref}\`. ${CONSEQUENCE}`,
      blocksVisualEditor: true,
    });
    return;
  }

  if (target.kind === "root") {
    ctx.issues.push({
      path: refPath,
      message: `\`$ref\` to the schema root is recursive, which constrained decoding does not support. ${CONSEQUENCE}`,
      blocksVisualEditor: true,
    });
    return;
  }

  if (!(target.name in ctx.defs)) {
    ctx.issues.push({
      path: refPath,
      message: `\`$ref\` points at \`$defs.${target.name}\`, which is not defined in this schema. ${CONSEQUENCE}`,
      blocksVisualEditor: true,
    });
    return;
  }

  if (isRecursiveDef(ctx.defs, target.name)) {
    ctx.issues.push({
      path: refPath,
      message: `\`$defs.${target.name}\` is recursive, which constrained decoding does not support. ${CONSEQUENCE}`,
      blocksVisualEditor: true,
    });
  }
}

function checkObject(
  node: Record<string, unknown>,
  path: string,
  ctx: WalkContext,
): void {
  if (node.additionalProperties !== false) {
    ctx.issues.push({
      path: childPath(path, "additionalProperties"),
      message: `Objects must set \`additionalProperties: false\` for constrained decoding. ${CONSEQUENCE}`,
    });
  }

  if (!isRecord(node.properties)) return;

  const required = Array.isArray(node.required)
    ? node.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  for (const key of Object.keys(node.properties)) {
    if (required.includes(key)) continue;
    ctx.issues.push({
      path: childPath(path, "properties", key),
      message: `Property \`${key}\` is missing from \`required\`. Constrained decoding requires every property to be listed. ${CONSEQUENCE}`,
    });
  }
}

function walk(node: unknown, path: string, ctx: WalkContext): void {
  if (!isRecord(node)) return;

  for (const keyword of OUT_OF_SUBSET_KEYWORDS) {
    if (!(keyword in node)) continue;
    ctx.issues.push({
      path: childPath(path, keyword),
      message: `\`${keyword}\` is not part of the constrained decoding subset. ${CONSEQUENCE}`,
    });
  }

  for (const keyword of UNSUPPORTED_COMPOSITION_KEYWORDS) {
    if (!(keyword in node)) continue;
    ctx.issues.push({
      path: childPath(path, keyword),
      message: `\`${keyword}\` is not part of the constrained decoding subset. ${CONSEQUENCE}`,
      blocksVisualEditor: true,
    });
  }

  if (typeof node.$ref === "string") checkRef(node.$ref, path, ctx);

  if (Array.isArray(node.anyOf)) {
    const valueIndex = nullableBranchIndex(node.anyOf);
    if (valueIndex === null) {
      // Reported once for the whole union; walking the branches of a
      // construction we cannot express would only add noise below it.
      ctx.issues.push({
        path: childPath(path, "anyOf"),
        message: `\`anyOf\` is only supported as the nullable pattern \`[{ ... }, { "type": "null" }]\`. ${CONSEQUENCE}`,
        blocksVisualEditor: true,
      });
    } else {
      walk(node.anyOf[valueIndex], childPath(path, "anyOf", valueIndex), ctx);
    }
  }

  if (node.type === "object" || isRecord(node.properties)) {
    checkObject(node, path, ctx);
  }

  if (isRecord(node.properties)) {
    for (const [key, value] of Object.entries(node.properties)) {
      walk(value, childPath(path, "properties", key), ctx);
    }
  }

  if (isRecord(node.items)) walk(node.items, childPath(path, "items"), ctx);

  if (Array.isArray(node.prefixItems)) {
    node.prefixItems.forEach((item, index) =>
      walk(item, childPath(path, "prefixItems", index), ctx),
    );
  }

  // `$defs` entries are validated where they are declared, not where they are
  // referenced, so a definition reused by several properties reports once.
  if (isRecord(node.$defs)) {
    for (const [name, value] of Object.entries(node.$defs)) {
      walk(value, childPath(path, "$defs", name), ctx);
    }
  }
}

function collectIssues(schema: unknown): InternalIssue[] {
  if (!isRecord(schema)) return [];

  const ctx: WalkContext = {
    defs: isRecord(schema.$defs) ? schema.$defs : {},
    issues: [],
  };
  walk(schema, ROOT_PATH, ctx);

  return ctx.issues;
}

/**
 * Reports where a schema leaves the constrained decoding subset. Returns an
 * empty list for input that is not an object; validating that a schema is
 * well-formed is `JSONSchemaFormSchema`'s job, not this module's.
 */
export function validateConstrainedDecodingSubset(
  schema: unknown,
): SubsetIssue[] {
  return collectIssues(schema).map(({ path, message }) => ({ path, message }));
}

/**
 * Whether the visual schema builder can round-trip a schema without losing
 * information. Keywords that are merely out of the subset (`minLength`, ...)
 * stay editable and surface as warnings; only constructions the builder has no
 * representation for disable it.
 */
export function isVisuallyEditable(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type !== "object") return false;
  if ("properties" in schema && !isRecord(schema.properties)) return false;

  return collectIssues(schema).every((issue) => !issue.blocksVisualEditor);
}
