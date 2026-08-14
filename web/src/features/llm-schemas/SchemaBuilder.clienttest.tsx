import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SchemaBuilder } from "@/src/features/llm-schemas/components/SchemaBuilder";
import {
  parseSchema,
  serializeSchema,
} from "@/src/features/llm-schemas/schemaBuilderModel";

/** Root object in the shape the builder always emits. */
const objectSchema = (
  properties: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...overrides,
});

const roundTrip = (schema: Record<string, unknown>) => {
  const root = parseSchema(schema);
  expect(root).not.toBeNull();
  return serializeSchema(root!);
};

describe("schema builder round trip", () => {
  it.each([
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["integer", { type: "integer" }],
    ["boolean", { type: "boolean" }],
    ["enum", { type: "string", enum: ["a", "b"] }],
    ["array of scalars", { type: "array", items: { type: "number" } }],
    [
      "nested object",
      objectSchema({ city: { type: "string" } }) as Record<string, unknown>,
    ],
    [
      "array of objects",
      {
        type: "array",
        items: objectSchema({ label: { type: "string" } }),
      },
    ],
  ])("round-trips a %s property", (_name, property) => {
    const schema = objectSchema({ field: property });

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("round-trips two levels of nesting", () => {
    const schema = objectSchema({
      user: objectSchema({
        addresses: {
          type: "array",
          items: objectSchema({
            street: { type: "string" },
            zip: { type: "string", enum: ["1000", "2000"] },
          }),
        },
      }),
    });

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("emits the constrained decoding shape at every level", () => {
    const schema = objectSchema({
      user: objectSchema({ name: { type: "string" } }),
      tags: {
        type: "array",
        items: objectSchema({ id: { type: "string" } }),
      },
    });

    const result = roundTrip(schema) as any;

    for (const node of [
      result,
      result.properties.user,
      result.properties.tags.items,
    ]) {
      expect(node.type).toBe("object");
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties));
    }
  });

  it("keeps optional properties optional instead of forcing `required`", () => {
    const result = roundTrip({
      type: "object",
      properties: { nickname: { type: "string" } },
      additionalProperties: false,
    });

    expect(result.required).toEqual([]);
  });

  it("keeps descriptions and required flags", () => {
    const schema = objectSchema(
      {
        name: { type: "string", description: "Full name" },
        nickname: { type: "string" },
      },
      { required: ["name"] },
    );

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("preserves keywords the builder does not own", () => {
    const schema = objectSchema(
      {
        name: { type: "string", minLength: 2, pattern: "^a", title: "Name" },
        scores: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          maxItems: 3,
        },
      },
      { $defs: { unused: { type: "string" } }, title: "Root" },
    );

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("round-trips nullable properties", () => {
    const schema = objectSchema({
      nickname: {
        description: "Optional nickname",
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      profile: {
        anyOf: [objectSchema({ bio: { type: "string" } }), { type: "null" }],
      },
    });

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("keeps a `$ref` property verbatim", () => {
    const schema = objectSchema(
      { address: { $ref: "#/$defs/address" } },
      { $defs: { address: objectSchema({ city: { type: "string" } }) } },
    );

    expect(roundTrip(schema)).toEqual(schema);
  });

  it("pins an absent `additionalProperties` to false", () => {
    const result = roundTrip({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    expect(result).toEqual(
      objectSchema({ name: { type: "string" } }) as Record<string, unknown>,
    );
  });

  it("skips rows that cannot become object keys", () => {
    const root = parseSchema(objectSchema({ name: { type: "string" } }))!;
    const [name] = root.children;

    const result = serializeSchema({
      ...root,
      children: [
        name,
        { ...name, id: "duplicate" },
        { ...name, id: "unnamed", name: "" },
      ],
    });

    expect(result).toEqual(
      objectSchema({ name: { type: "string" } }) as Record<string, unknown>,
    );
  });
});

describe("schema builder rejection", () => {
  it.each([
    ["a non-object root", { type: "string" }],
    ["invalid JSON", "{"],
    ["`allOf`", objectSchema({ user: { allOf: [{ type: "object" }] } })],
    ["`if`/`then`", objectSchema({ user: { if: {}, then: {} } })],
    [
      "a non-nullable `anyOf`",
      objectSchema({
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      }),
    ],
    [
      "a recursive `$ref`",
      objectSchema(
        { node: { $ref: "#/$defs/node" } },
        {
          $defs: {
            node: objectSchema({ child: { $ref: "#/$defs/node" } }),
          },
        },
      ),
    ],
    [
      "an external `$ref`",
      objectSchema({ user: { $ref: "https://example.com/user.json" } }),
    ],
    [
      "an explicit `additionalProperties: true`",
      objectSchema(
        { user: { type: "object", properties: {} } },
        {
          additionalProperties: true,
        },
      ),
    ],
    [
      "a tuple array",
      objectSchema({
        pair: { type: "array", prefixItems: [{ type: "string" }] },
      }),
    ],
    ["a typeless property", objectSchema({ anything: {} })],
    [
      "a non-string enum",
      objectSchema({ level: { type: "integer", enum: [1, 2] } }),
    ],
  ])("refuses %s", (_name, schema) => {
    expect(parseSchema(schema)).toBeNull();
  });
});

describe("SchemaBuilder component", () => {
  const emptySchema = JSON.stringify(
    objectSchema({}, { required: [] }),
    null,
    2,
  );

  it("emits a schema when a property is added and named", () => {
    const onChange = vi.fn();
    render(<SchemaBuilder value={emptySchema} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    fireEvent.change(screen.getByLabelText("Property name"), {
      target: { value: "title" },
    });

    expect(JSON.parse(onChange.mock.lastCall![0])).toEqual(
      objectSchema({ title: { type: "string" } }),
    );
  });

  it("renders inert controls when disabled", () => {
    render(
      <SchemaBuilder
        value={JSON.stringify(objectSchema({ name: { type: "string" } }))}
        onChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByLabelText("Property name")).toBeDisabled();
    expect(screen.getByLabelText("Required")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add property" })).toBeDisabled();
  });

  it("refuses to edit a schema it cannot represent", () => {
    const onChange = vi.fn();
    render(
      <SchemaBuilder
        value={JSON.stringify(
          objectSchema({ user: { allOf: [{ type: "object" }] } }),
        )}
        onChange={onChange}
      />,
    );

    expect(screen.queryByLabelText("Property name")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
