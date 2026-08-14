import { describe, expect, it } from "vitest";

import {
  isVisuallyEditable,
  validateConstrainedDecodingSubset,
} from "./constrainedDecoding";

/** Builds a root object schema that is inside the subset by default. */
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

const paths = (schema: unknown) =>
  validateConstrainedDecodingSubset(schema).map((issue) => issue.path);

describe("validateConstrainedDecodingSubset", () => {
  describe("keywords outside the subset", () => {
    it.each(["minimum", "maximum", "multipleOf"])(
      "warns about `%s`",
      (keyword) => {
        const schema = objectSchema({
          age: { type: "integer", [keyword]: 1 },
        });

        expect(paths(schema)).toEqual([`#/properties/age/${keyword}`]);
      },
    );

    it.each(["minLength", "maxLength", "pattern"])(
      "warns about `%s`",
      (keyword) => {
        const schema = objectSchema({
          name: { type: "string", [keyword]: keyword === "pattern" ? "^a" : 1 },
        });

        expect(paths(schema)).toEqual([`#/properties/name/${keyword}`]);
      },
    );

    it("warns once per keyword when several are present on the same node", () => {
      const schema = objectSchema({
        age: { type: "integer", minimum: 0, maximum: 10 },
      });

      expect(paths(schema)).toEqual([
        "#/properties/age/minimum",
        "#/properties/age/maximum",
      ]);
    });

    it("warns about `allOf`", () => {
      const schema = objectSchema({
        user: { allOf: [{ type: "object" }] },
      });

      expect(paths(schema)).toEqual(["#/properties/user/allOf"]);
    });

    it("warns about `if`/`then`/`else`", () => {
      const schema = objectSchema({
        user: { type: "string", if: {}, then: {}, else: {} },
      });

      expect(paths(schema)).toEqual([
        "#/properties/user/if",
        "#/properties/user/then",
        "#/properties/user/else",
      ]);
    });

    it("states that Bedrock returns a 400 rather than degrading", () => {
      const [issue] = validateConstrainedDecodingSubset(
        objectSchema({ name: { type: "string", minLength: 1 } }),
      );

      expect(issue.message).toContain("`minLength`");
      expect(issue.message).toContain("400");
    });
  });

  describe("anyOf", () => {
    it("accepts the nullable pattern", () => {
      const schema = objectSchema({
        nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
      });

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("accepts the nullable pattern with the null branch first", () => {
      const schema = objectSchema({
        nickname: { anyOf: [{ type: "null" }, { type: "string" }] },
      });

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("still validates the value branch of a nullable union", () => {
      const schema = objectSchema({
        nickname: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        },
      });

      expect(paths(schema)).toEqual([
        "#/properties/nickname/anyOf/0/minLength",
      ]);
    });

    it("warns about a union that is not the nullable pattern", () => {
      const schema = objectSchema({
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      });

      expect(paths(schema)).toEqual(["#/properties/value/anyOf"]);
    });

    it("warns once and does not descend into the branches", () => {
      const schema = objectSchema({
        value: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "number", minimum: 0 },
            { type: "null" },
          ],
        },
      });

      expect(paths(schema)).toEqual(["#/properties/value/anyOf"]);
    });

    it("does not warn about a nullable declared as a type array", () => {
      const schema = objectSchema({
        nickname: { type: ["string", "null"] },
      });

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });
  });

  describe("$ref", () => {
    it("accepts an internal, non-recursive $ref", () => {
      const schema = objectSchema(
        { home: { $ref: "#/$defs/Address" } },
        {
          $defs: {
            Address: objectSchema({ city: { type: "string" } }),
          },
        },
      );

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("treats a $def reused by several properties as reuse, not recursion", () => {
      const schema = objectSchema(
        {
          home: { $ref: "#/$defs/Address" },
          work: { $ref: "#/$defs/Address" },
        },
        {
          $defs: {
            Address: objectSchema({ city: { type: "string" } }),
          },
        },
      );

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("warns about a self-referencing $def", () => {
      const schema = objectSchema(
        { node: { $ref: "#/$defs/Node" } },
        {
          $defs: {
            Node: objectSchema({ child: { $ref: "#/$defs/Node" } }),
          },
        },
      );

      expect(paths(schema)).toEqual([
        "#/properties/node/$ref",
        "#/$defs/Node/properties/child/$ref",
      ]);
    });

    it("warns about a mutually recursive $def", () => {
      const schema = objectSchema(
        { a: { $ref: "#/$defs/A" } },
        {
          $defs: {
            A: objectSchema({ b: { $ref: "#/$defs/B" } }),
            B: objectSchema({ a: { $ref: "#/$defs/A" } }),
          },
        },
      );

      expect(paths(schema)).toEqual([
        "#/properties/a/$ref",
        "#/$defs/A/properties/b/$ref",
        "#/$defs/B/properties/a/$ref",
      ]);
    });

    it("warns about a $ref to the schema root", () => {
      const schema = objectSchema({ self: { $ref: "#" } });

      expect(paths(schema)).toEqual(["#/properties/self/$ref"]);
    });

    it("warns about an external $ref", () => {
      const schema = objectSchema({
        address: { $ref: "https://example.com/address.json" },
      });

      expect(paths(schema)).toEqual(["#/properties/address/$ref"]);
    });

    it("warns about a $ref that resolves to nothing", () => {
      const schema = objectSchema({
        address: { $ref: "#/$defs/Missing" },
      });

      expect(paths(schema)).toEqual(["#/properties/address/$ref"]);
    });
  });

  describe("object requirements", () => {
    it("warns when an object does not set `additionalProperties: false`", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };

      expect(paths(schema)).toEqual(["#/additionalProperties"]);
    });

    it("warns for every property missing from `required`", () => {
      const schema = objectSchema(
        { name: { type: "string" }, age: { type: "integer" } },
        { required: ["name"] },
      );

      expect(paths(schema)).toEqual(["#/properties/age"]);
    });

    it("warns when `required` is absent entirely", () => {
      const schema = objectSchema(
        { name: { type: "string" } },
        { required: undefined },
      );

      expect(paths(schema)).toEqual(["#/properties/name"]);
    });

    it("applies the object rules at every nesting level", () => {
      const schema = objectSchema({
        user: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      });

      expect(paths(schema)).toEqual([
        "#/properties/user/additionalProperties",
        "#/properties/user/properties/name",
      ]);
    });
  });

  describe("constructions inside the subset", () => {
    it("does not warn about scalars, enum and const", () => {
      const schema = objectSchema({
        name: { type: "string" },
        age: { type: "integer" },
        score: { type: "number" },
        active: { type: "boolean" },
        status: { type: "string", enum: ["open", "closed"] },
        kind: { const: "call" },
      });

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("does not warn about nested objects and arrays of objects", () => {
      const schema = objectSchema({
        user: objectSchema({
          address: objectSchema({ city: { type: "string" } }),
        }),
        tags: { type: "array", items: { type: "string" } },
        contacts: {
          type: "array",
          items: objectSchema({ email: { type: "string" } }),
        },
      });

      expect(validateConstrainedDecodingSubset(schema)).toEqual([]);
    });

    it("reports the deep path for a violation two levels down", () => {
      const schema = objectSchema({
        contacts: {
          type: "array",
          items: objectSchema({ email: { type: "string", pattern: "^a" } }),
        },
      });

      expect(paths(schema)).toEqual([
        "#/properties/contacts/items/properties/email/pattern",
      ]);
    });
  });

  describe("input that is not a schema object", () => {
    it.each([null, undefined, "{}", 42, [{ type: "object" }]])(
      "returns no issues for %p",
      (input) => {
        expect(validateConstrainedDecodingSubset(input)).toEqual([]);
      },
    );
  });
});

describe("isVisuallyEditable", () => {
  it("accepts a schema inside the subset", () => {
    expect(isVisuallyEditable(objectSchema({ name: { type: "string" } }))).toBe(
      true,
    );
  });

  it("stays editable for keywords that only warn", () => {
    const schema = objectSchema({ name: { type: "string", minLength: 1 } });

    expect(validateConstrainedDecodingSubset(schema)).toHaveLength(1);
    expect(isVisuallyEditable(schema)).toBe(true);
  });

  it("stays editable when a property is missing from `required`", () => {
    const schema = objectSchema({ name: { type: "string" } }, { required: [] });

    expect(isVisuallyEditable(schema)).toBe(true);
  });

  it("rejects `allOf`", () => {
    expect(
      isVisuallyEditable(
        objectSchema({ user: { allOf: [{ type: "object" }] } }),
      ),
    ).toBe(false);
  });

  it("rejects `if`/`then`/`else`", () => {
    expect(
      isVisuallyEditable(objectSchema({ user: { if: {}, then: {} } })),
    ).toBe(false);
  });

  it("rejects a union that is not the nullable pattern", () => {
    expect(
      isVisuallyEditable(
        objectSchema({
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        }),
      ),
    ).toBe(false);
  });

  it("accepts the nullable pattern", () => {
    expect(
      isVisuallyEditable(
        objectSchema({
          nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a recursive $ref and accepts a non-recursive one", () => {
    const defs = {
      Address: objectSchema({ city: { type: "string" } }),
      Node: objectSchema({ child: { $ref: "#/$defs/Node" } }),
    };

    expect(
      isVisuallyEditable(
        objectSchema(
          { home: { $ref: "#/$defs/Address" } },
          { $defs: { Address: defs.Address } },
        ),
      ),
    ).toBe(true);
    expect(
      isVisuallyEditable(
        objectSchema(
          { node: { $ref: "#/$defs/Node" } },
          { $defs: { Node: defs.Node } },
        ),
      ),
    ).toBe(false);
  });

  it("rejects an external $ref", () => {
    expect(
      isVisuallyEditable(
        objectSchema({ address: { $ref: "https://example.com/a.json" } }),
      ),
    ).toBe(false);
  });

  it("rejects input that is not a root object schema", () => {
    expect(isVisuallyEditable(null)).toBe(false);
    expect(isVisuallyEditable("{}")).toBe(false);
    expect(isVisuallyEditable({ type: "string" })).toBe(false);
    expect(isVisuallyEditable({ type: "object", properties: [] })).toBe(false);
  });
});
