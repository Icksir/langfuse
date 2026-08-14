/**
 * Config editor for a prompt: a guided structured-output section on top of the
 * raw `config` JSON, which stays editable underneath.
 *
 * The serialised config string is the single source of truth. Everything the
 * section renders — the selected schema, the subset warnings, the tool conflict
 * — is derived from it during render, so the guided controls and the raw editor
 * can never disagree. Writes go through `mergePlaygroundConfig`, which keeps
 * keys the playground does not own (`model`, `temperature`, ...) and the tools
 * the config already carried: a prompt config is user data, and editing the
 * schema must not delete the parts of it this UI does not show.
 */

import React, { useState } from "react";
import { ChevronRight, X } from "lucide-react";

import { Button } from "@/src/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/src/components/ui/collapsible";
import { CodeMirrorEditor } from "@/src/components/editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/src/components/ui/tabs";
import { SchemaBuilder } from "@/src/features/llm-schemas/components/SchemaBuilder";
import {
  isVisuallyEditable,
  validateConstrainedDecodingSubset,
} from "@/src/features/llm-schemas/constrainedDecoding";
import {
  mergePlaygroundConfig,
  parsePlaygroundConfig,
  PLAYGROUND_CONFIG_KEYS,
  type PromptConfigSchema,
} from "@/src/features/llm-schemas/promptConfig";
import { CreateOrEditLLMSchemaDialog } from "@/src/features/playground/page/components/CreateOrEditLLMSchemaDialog";
import { api } from "@/src/utils/api";
import { cn } from "@/src/utils/tailwind";
import {
  hasPromptToolStructuredOutputConflict,
  parsePromptToolConfig,
  PROMPT_TOOL_STRUCTURED_OUTPUT_CONFLICT_MESSAGE,
  type LlmSchema,
} from "@langfuse/shared";

/** Schema slice as it lives on the config, without the render-only id. */
type StructuredOutputSchema = Omit<PromptConfigSchema, "id">;

export type PromptConfigSectionProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  projectId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `null` marks input the guided controls must not touch, not empty config. */
function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const stringify = (value: unknown) => JSON.stringify(value, null, 2);

const hasForeignKeys = (config: Record<string, unknown> | null) =>
  Boolean(
    config &&
    Object.keys(config).some(
      (key) => !PLAYGROUND_CONFIG_KEYS.includes(key as never),
    ),
  );

const toStructuredOutputSchema = (
  llmSchema: LlmSchema,
): StructuredOutputSchema => ({
  name: llmSchema.name,
  description: llmSchema.description,
  schema: llmSchema.schema as StructuredOutputSchema["schema"],
});

export const PromptConfigSection: React.FC<PromptConfigSectionProps> = ({
  value,
  onChange,
  onBlur,
  projectId,
}) => {
  const config = parseJsonRecord(value);
  const { tools, structuredOutputSchema } = parsePlaygroundConfig(config ?? {});

  const { data: savedSchemas = [] } = api.llmSchemas.getAll.useQuery(
    { projectId: projectId as string },
    { enabled: Boolean(projectId), staleTime: 1000 * 60 * 5 },
  );

  const [tab, setTab] = useState<"easy" | "json">("easy");
  // Someone whose config is hand-written should see it, not a closed section.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => !structuredOutputSchema && hasForeignKeys(config),
  );

  const schemaText = structuredOutputSchema
    ? stringify(structuredOutputSchema.schema)
    : "";

  // In-flight JSON text: the editor must accept input that does not parse yet,
  // while the config only ever receives valid JSON. `source` tracks the text
  // last read from or written to the config, so an externally changed schema
  // re-syncs without an effect and typing is never overwritten.
  const [draft, setDraft] = useState(() => ({
    source: schemaText,
    text: schemaText,
  }));
  if (draft.source !== schemaText) {
    setDraft({ source: schemaText, text: schemaText });
  }

  const commitSchema = (schema: StructuredOutputSchema | null) => {
    const parsed = config ?? {};
    onChange(
      stringify(
        mergePlaygroundConfig(parsed, {
          tools,
          structuredOutputSchema: schema,
        }),
      ),
    );
  };

  const handleSelectSchema = (llmSchema: LlmSchema) =>
    commitSchema(toStructuredOutputSchema(llmSchema));

  const handleSchemaBodyChange = (text: string) => {
    const parsed = parseJsonRecord(text);
    if (!parsed || !structuredOutputSchema) {
      setDraft({ source: schemaText, text });
      return;
    }

    // The committed schema re-serialises to this exact text, so the sync above
    // does not fire and discard what the user is typing.
    setDraft({ source: stringify(parsed), text });
    commitSchema({ ...structuredOutputSchema, schema: parsed });
  };

  const prettifySchema = () => {
    const parsed = parseJsonRecord(draft.text);
    if (parsed)
      setDraft({ source: stringify(parsed), text: stringify(parsed) });
  };

  const subsetIssues = structuredOutputSchema
    ? validateConstrainedDecodingSubset(structuredOutputSchema.schema)
    : [];
  const visuallyEditable = structuredOutputSchema
    ? isVisuallyEditable(structuredOutputSchema.schema)
    : true;
  const activeTab = visuallyEditable ? tab : "json";
  const draftError = parseJsonRecord(draft.text)
    ? null
    : "Schema needs to be a valid JSON object. The config keeps the last valid version.";

  const hasToolConflict = hasPromptToolStructuredOutputConflict(
    parsePromptToolConfig(config),
    Boolean(structuredOutputSchema),
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-bold">Config</p>
        <p className="text-muted-foreground text-sm">
          Arbitrary JSON configuration that is available on the prompt. Use this
          to track LLM parameters, function definitions, or any other metadata.
        </p>
      </div>

      {config === null ? (
        <p className="text-destructive text-sm">
          Config needs to be valid JSON before structured output can be edited
          here.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-bold">Structured output</p>
            <p className="text-muted-foreground text-xs">
              Constrain the model response to a JSON schema. Saved on the prompt
              config and reused by the playground and experiments.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={structuredOutputSchema?.name ?? ""}
              onValueChange={(name) => {
                const selected = savedSchemas.find(
                  (schema) => schema.name === name,
                );
                if (selected) handleSelectSchema(selected);
              }}
            >
              <SelectTrigger
                aria-label="Structured output schema"
                className="min-w-56 flex-1"
              >
                <SelectValue placeholder="Select a schema" />
              </SelectTrigger>
              <SelectContent>
                {savedSchemas.map((schema) => (
                  <SelectItem key={schema.id} value={schema.name}>
                    {schema.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {projectId ? (
              <CreateOrEditLLMSchemaDialog
                projectId={projectId}
                onSave={handleSelectSchema}
              >
                <Button type="button" variant="outline">
                  New schema
                </Button>
              </CreateOrEditLLMSchemaDialog>
            ) : null}

            {structuredOutputSchema ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove structured output schema"
                onClick={() => commitSchema(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          {structuredOutputSchema ? (
            <>
              <Tabs
                value={activeTab}
                onValueChange={(next) => setTab(next as "easy" | "json")}
              >
                <TabsList>
                  <TabsTrigger
                    value="easy"
                    disabled={!visuallyEditable}
                    title={
                      visuallyEditable
                        ? undefined
                        : "This schema uses constructions the visual editor cannot represent."
                    }
                  >
                    Easy
                  </TabsTrigger>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>

                <TabsContent value="easy" className="pt-2">
                  <SchemaBuilder
                    value={schemaText}
                    onChange={handleSchemaBodyChange}
                  />
                </TabsContent>

                <TabsContent value="json" className="flex flex-col gap-2 pt-2">
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={prettifySchema}
                    >
                      Prettify
                    </Button>
                  </div>
                  <CodeMirrorEditor
                    value={draft.text}
                    onChange={handleSchemaBodyChange}
                    onBlur={onBlur}
                    editable
                    mode="json"
                  />
                  {draftError ? (
                    <p className="text-destructive text-xs">{draftError}</p>
                  ) : null}
                </TabsContent>
              </Tabs>

              {subsetIssues.length > 0 ? (
                <div className="border-border bg-muted/40 flex flex-col gap-1 rounded-md border p-2">
                  <p className="text-xs font-bold">
                    Outside the constrained decoding subset
                  </p>
                  <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                    {subsetIssues.map((issue) => (
                      <li key={`${issue.path}:${issue.message}`}>
                        <code>{issue.path}</code> — {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          {hasToolConflict ? (
            <p className="text-destructive text-xs">
              {PROMPT_TOOL_STRUCTURED_OUTPUT_CONFLICT_MESSAGE}
            </p>
          ) : null}
        </div>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2"
          >
            <ChevronRight
              className={cn(
                "mr-1 h-4 w-4 transition-transform",
                advancedOpen && "rotate-90",
              )}
            />
            Advanced: raw config JSON
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <CodeMirrorEditor
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            editable
            mode="json"
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
