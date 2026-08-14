/**
 * Row model behind the visual schema builder, and its conversion to and from
 * JSON Schema.
 *
 * The conversion is deliberately conservative: `parseSchema` returns `null` for
 * anything it cannot represent rather than dropping the parts it does not
 * understand. A builder that silently normalises is a builder that destroys
 * schemas the moment a user opens the tab, so every construction is either
 * round-tripped or refused.
 *
 * Keywords that are merely outside the constrained decoding subset
 * (`minLength`, `pattern`, `title`, `$defs`, ...) stay editable: they are kept
 * verbatim in `extras` and merged back on serialisation, with the keywords the
 * builder owns always winning.
 */

import { isVisuallyEditable, nullableBranchIndex } from "./constrainedDecoding";

export const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;

export type ScalarType = (typeof SCALAR_TYPES)[number];

export type PropertyType =
  | ScalarType
  | "enum"
  | "arrayOfScalars"
  | "object"
  | "arrayOfObjects"
  /** `$ref` into `$defs`: preserved verbatim, rendered read-only. */
  | "reference";

export type SchemaNode = {
  /** Stable row identity for React. Never serialised. */
  id: string;
  name: string;
  type: PropertyType;
  description: string;
  required: boolean;
  /** Serialises as `anyOf: [<node>, { "type": "null" }]`. */
  nullable: boolean;
  enumValues: string[];
  itemType: ScalarType;
  children: SchemaNode[];
  /** Keywords the builder does not own, preserved across the round trip. */
  extras: Record<string, unknown>;
  /** Same, for the `items` schema of an array. */
  itemExtras: Record<string, unknown>;
  /** Same, for the `anyOf` wrapper of a nullable node. */
  nullableExtras: Record<string, unknown>;
};

export type SchemaRoot = {
  children: SchemaNode[];
  extras: Record<string, unknown>;
};

/** Deterministic ids keep tests and rerenders stable. */
let nextId = 0;
export const createNodeId = () => `schema-node-${nextId++}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const isScalarType = (value: unknown): value is ScalarType =>
  SCALAR_TYPES.includes(value as ScalarType);

const omit = (source: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );

/** Everything a row carries except its identity within the parent object. */
type NodeBody = Omit<SchemaNode, "id" | "name" | "required">;

const emptyBody = (): NodeBody => ({
  type: "string",
  description: "",
  nullable: false,
  enumValues: [],
  itemType: "string",
  children: [],
  extras: {},
  itemExtras: {},
  nullableExtras: {},
});

export function createNode(overrides: Partial<SchemaNode> = {}): SchemaNode {
  return {
    id: createNodeId(),
    name: "",
    required: true,
    ...emptyBody(),
    ...overrides,
  };
}

function parseObjectBody(raw: Record<string, unknown>): NodeBody | null {
  // An explicit `additionalProperties: true` is a statement we would silently
  // contradict; an absent one is unspecified and safe to pin to `false`.
  if (raw.additionalProperties === true) return null;

  const properties = isRecord(raw.properties) ? raw.properties : {};
  const required = Array.isArray(raw.required)
    ? raw.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  const children: SchemaNode[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const body = parseNode(value);
    if (!body) return null;
    children.push({
      id: createNodeId(),
      name,
      required: required.includes(name),
      ...body,
    });
  }

  return {
    ...emptyBody(),
    type: "object",
    description: asString(raw.description),
    children,
    extras: omit(raw, [
      "type",
      "properties",
      "required",
      "additionalProperties",
      "description",
    ]),
  };
}

function parseArrayBody(raw: Record<string, unknown>): NodeBody | null {
  if (!isRecord(raw.items)) return null;

  const item = parseNode(raw.items);
  if (!item || item.nullable) return null;

  const extras = omit(raw, ["type", "items", "description"]);
  const description = asString(raw.description);
  // The item's own description has no row of its own, so it goes back where it
  // came from instead of being dropped.
  const itemDescription = item.description
    ? { description: item.description }
    : {};

  if (item.type === "object") {
    return {
      ...emptyBody(),
      type: "arrayOfObjects",
      description,
      children: item.children,
      extras,
      itemExtras: { ...item.extras, ...itemDescription },
    };
  }

  if (isScalarType(item.type)) {
    return {
      ...emptyBody(),
      type: "arrayOfScalars",
      description,
      itemType: item.type,
      extras,
      itemExtras: { ...item.extras, ...itemDescription },
    };
  }

  return null;
}

/** Parses a property schema, or returns `null` when it is not representable. */
function parseNode(raw: unknown): NodeBody | null {
  if (!isRecord(raw)) return null;

  if (Array.isArray(raw.anyOf)) {
    const index = nullableBranchIndex(raw.anyOf);
    if (index === null) return null;

    const inner = parseNode(raw.anyOf[index]);
    if (!inner || inner.nullable) return null;

    return {
      ...inner,
      nullable: true,
      // A description on the wrapper wins; one on the branch is lifted out and
      // re-emitted on the wrapper.
      description: asString(raw.description) || inner.description,
      nullableExtras: omit(raw, ["anyOf", "description"]),
    };
  }

  if (typeof raw.$ref === "string") {
    return {
      ...emptyBody(),
      type: "reference",
      description: asString(raw.description),
      extras: { ...raw },
    };
  }

  if (raw.type === "object" || (!("type" in raw) && isRecord(raw.properties))) {
    return parseObjectBody(raw);
  }

  if (raw.type === "array") return parseArrayBody(raw);

  if (Array.isArray(raw.enum)) {
    if (raw.type !== undefined && raw.type !== "string") return null;
    if (!raw.enum.every((entry) => typeof entry === "string")) return null;

    return {
      ...emptyBody(),
      type: "enum",
      description: asString(raw.description),
      enumValues: [...(raw.enum as string[])],
      extras: omit(raw, ["type", "enum", "description"]),
    };
  }

  if (isScalarType(raw.type)) {
    return {
      ...emptyBody(),
      type: raw.type,
      description: asString(raw.description),
      extras: omit(raw, ["type", "description"]),
    };
  }

  return null;
}

/**
 * Converts a serialised schema into builder rows, or returns `null` when the
 * visual editor cannot round-trip it. Accepts the JSON string the form field
 * holds as well as an already parsed value.
 */
export function parseSchema(input: unknown): SchemaRoot | null {
  let schema = input;
  if (typeof input === "string") {
    try {
      schema = JSON.parse(input);
    } catch {
      return null;
    }
  }

  if (!isVisuallyEditable(schema) || !isRecord(schema)) return null;

  const body = parseObjectBody(schema);
  return body ? { children: body.children, extras: body.extras } : null;
}

/** Rows that cannot become object keys are skipped rather than emitted broken. */
function usableChildren(nodes: SchemaNode[]): SchemaNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (!node.name || seen.has(node.name)) return false;
    seen.add(node.name);
    return true;
  });
}

function serializeObject(
  children: SchemaNode[],
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const usable = usableChildren(children);

  return {
    ...extras,
    type: "object",
    properties: Object.fromEntries(
      usable.map((node) => [node.name, serializeNode(node)]),
    ),
    required: usable.filter((node) => node.required).map((node) => node.name),
    additionalProperties: false,
  };
}

function serializeBody(node: SchemaNode): Record<string, unknown> {
  switch (node.type) {
    case "reference":
      return { ...node.extras };
    case "object":
      return serializeObject(node.children, node.extras);
    case "arrayOfObjects":
      return {
        ...node.extras,
        type: "array",
        items: serializeObject(node.children, node.itemExtras),
      };
    case "arrayOfScalars":
      return {
        ...node.extras,
        type: "array",
        items: { ...node.itemExtras, type: node.itemType },
      };
    case "enum":
      return {
        ...node.extras,
        type: "string",
        enum: [...node.enumValues],
      };
    default:
      return { ...node.extras, type: node.type };
  }
}

function serializeNode(node: SchemaNode): Record<string, unknown> {
  const body = serializeBody(node);
  // A reference row is read-only, so its description already lives in `extras`.
  const description =
    node.description && node.type !== "reference"
      ? { description: node.description }
      : {};

  if (!node.nullable) return { ...body, ...description };

  return {
    ...node.nullableExtras,
    ...description,
    anyOf: [body, { type: "null" }],
  };
}

/** Always emits the constrained decoding object shape, at every level. */
export function serializeSchema(root: SchemaRoot): Record<string, unknown> {
  return serializeObject(root.children, root.extras);
}

export function serializeSchemaToString(root: SchemaRoot): string {
  return JSON.stringify(serializeSchema(root), null, 2);
}

/**
 * Applies a type change without carrying over fields that no longer apply, so a
 * schema cannot keep an `enum` from a type the row no longer has.
 */
export function changeNodeType(
  node: SchemaNode,
  type: PropertyType,
): SchemaNode {
  if (type === node.type) return node;

  return {
    ...node,
    ...emptyBody(),
    type,
    description: node.description,
    nullable: node.nullable,
    enumValues: type === "enum" ? [""] : [],
    children: type === "object" || type === "arrayOfObjects" ? [] : [],
  };
}
