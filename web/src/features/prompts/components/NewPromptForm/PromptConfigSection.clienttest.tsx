import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getAllUseQuery: vi.fn(),
}));

vi.mock("@/src/utils/api", () => ({
  api: {
    llmSchemas: {
      getAll: {
        useQuery: (...args: unknown[]) => mocks.getAllUseQuery(...args),
      },
    },
  },
}));

// The dialog persists to the project catalog through tRPC; these tests cover
// the config merge, not the catalog write.
vi.mock(
  "@/src/features/playground/page/components/CreateOrEditLLMSchemaDialog",
  () => ({
    CreateOrEditLLMSchemaDialog: ({
      children,
    }: {
      children: React.ReactNode;
    }) => <>{children}</>,
  }),
);

vi.mock("@/src/components/editor", () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => <textarea value={value} onChange={(e) => onChange?.(e.target.value)} />,
}));

import { PromptConfigSection } from "./PromptConfigSection";

const personSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

const savedSchema = {
  id: "schema-1",
  name: "person",
  description: "A person",
  schema: personSchema,
};

/** Holds the config the way the form field does, so writes are observable. */
const renderSection = (initialConfig: unknown) => {
  const state = { config: JSON.stringify(initialConfig, null, 2) };

  const Harness = () => {
    const [value, setValue] = useState(state.config);
    return (
      <PromptConfigSection
        value={value}
        onChange={(next) => {
          state.config = next;
          setValue(next);
        }}
        projectId="project-1"
      />
    );
  };

  render(<Harness />);

  return { getConfig: () => JSON.parse(state.config) };
};

const selectPersonSchema = async () => {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByText("person"));
};

describe("PromptConfigSection", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    mocks.getAllUseQuery.mockReset();
    mocks.getAllUseQuery.mockReturnValue({ data: [savedSchema] });
  });

  it("keeps config keys it does not own when a schema is selected", async () => {
    const tool = {
      name: "get_weather",
      description: "Weather",
      parameters: { type: "object", properties: {} },
    };
    const { getConfig } = renderSection({
      model: "gpt-4o",
      temperature: 0.5,
      tools: [tool],
    });

    await selectPersonSchema();

    const config = getConfig();
    expect(config.model).toBe("gpt-4o");
    expect(config.temperature).toBe(0.5);
    expect(config.tools).toEqual([tool]);
    expect(config.structuredOutputSchema).toEqual({
      name: "person",
      description: "A person",
      schema: personSchema,
    });
    expect(config.response_format.json_schema.name).toBe("person");
  });

  it("removes both schema keys and keeps the rest when the schema is cleared", async () => {
    const { getConfig } = renderSection({
      model: "gpt-4o",
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: personSchema,
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /remove structured output schema/i }),
    );

    const config = getConfig();
    expect(config).toEqual({ model: "gpt-4o" });
  });

  it("keeps name, description and foreign keys when a property is edited", () => {
    const { getConfig } = renderSection({
      model: "gpt-4o",
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: personSchema,
      },
    });

    fireEvent.change(screen.getByLabelText("Property description"), {
      target: { value: "Full name" },
    });

    const config = getConfig();
    expect(config.model).toBe("gpt-4o");
    expect(config.structuredOutputSchema.name).toBe("person");
    expect(config.structuredOutputSchema.description).toBe("A person");
    expect(config.structuredOutputSchema.schema.properties.name).toEqual({
      type: "string",
      description: "Full name",
    });
  });

  it("warns about a schema outside the constrained decoding subset", () => {
    renderSection({
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: {
          ...personSchema,
          properties: { name: { type: "string", minLength: 2 } },
        },
      },
    });

    expect(
      screen.getByText("Outside the constrained decoding subset"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/`minLength` is not part of/, { selector: "li" }),
    ).toBeInTheDocument();
  });

  it("falls back to the JSON tab for schemas the visual editor cannot represent", () => {
    renderSection({
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: {
          ...personSchema,
          properties: { name: { allOf: [{ type: "string" }] } },
        },
      },
    });

    expect(screen.getByRole("tab", { name: "Easy" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("warns when the prompt carries both tools and a schema", () => {
    renderSection({
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: {} },
        },
      ],
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: personSchema,
      },
    });

    expect(
      screen.getByText(/not compatible with structured output/i),
    ).toBeInTheDocument();
  });

  it("disables the guided controls while the raw config is not valid JSON", () => {
    render(
      <PromptConfigSection
        value="{ not json"
        onChange={vi.fn()}
        projectId="project-1"
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByText(/config needs to be valid json/i),
    ).toBeInTheDocument();
  });

  it("does not write an unparseable schema to the config", () => {
    const { getConfig } = renderSection({
      structuredOutputSchema: {
        name: "person",
        description: "A person",
        schema: personSchema,
      },
    });

    // Radix activates a tab on mousedown, not click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: '{ "type": "obj' },
    });

    expect(getConfig().structuredOutputSchema.schema).toEqual(personSchema);
    expect(screen.getByText(/valid JSON object/i)).toBeInTheDocument();
  });
});
