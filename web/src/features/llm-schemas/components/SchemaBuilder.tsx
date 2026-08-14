/**
 * Visual editor for JSON schemas, controlled purely through `value`/`onChange`.
 * It knows nothing about tRPC, dialogs or forms so it can back any field that
 * holds a serialised schema.
 *
 * The constrained decoding shape (`additionalProperties: false`, a complete
 * `required`) is emitted at every level and never exposed in the UI: a
 * non-technical user cannot produce an invalid schema because the problematic
 * fields do not exist here.
 */

import React, { useState } from "react";
import { Plus, Trash } from "lucide-react";

import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/design-system/Checkbox/Checkbox";
import { Input } from "@/src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  changeNodeType,
  createNode,
  parseSchema,
  serializeSchemaToString,
  SCALAR_TYPES,
  type PropertyType,
  type ScalarType,
  type SchemaNode,
  type SchemaRoot,
} from "@/src/features/llm-schemas/schemaBuilderModel";
import { cn } from "@/src/utils/tailwind";

export type SchemaBuilderProps = {
  /** Serialised JSON schema, the same shape as the `schema` field. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

/**
 * Labelled with the JSON Schema keyword each row emits, so a user switching to
 * a raw JSON view of the same schema reads the same words back. `number` and
 * `integer` are both offered because the distinction is meaningful to a
 * constrained decoding provider: `integer` forbids a decimal point.
 */
const TYPE_OPTIONS: {
  value: Exclude<PropertyType, "reference">;
  label: string;
}[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Boolean" },
  { value: "enum", label: "Enum" },
  { value: "arrayOfScalars", label: "Array of values" },
  { value: "object", label: "Object" },
  { value: "arrayOfObjects", label: "Array of objects" },
];

const SCALAR_LABELS: Record<ScalarType, string> = {
  string: "String",
  number: "Number",
  integer: "Integer",
  boolean: "Boolean",
};

type RowsProps = {
  nodes: SchemaNode[];
  onNodesChange: (nodes: SchemaNode[]) => void;
  disabled: boolean;
  depth: number;
};

const duplicateNames = (nodes: SchemaNode[]) => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (!node.name) continue;
    if (seen.has(node.name)) duplicates.add(node.name);
    seen.add(node.name);
  }
  return duplicates;
};

const PropertyRow: React.FC<
  Omit<RowsProps, "nodes"> & { node: SchemaNode; isDuplicate: boolean }
> = ({ node, onNodesChange, disabled, depth, isDuplicate }) => {
  const update = (patch: Partial<SchemaNode>) =>
    onNodesChange([{ ...node, ...patch }]);
  const isReference = node.type === "reference";
  const rowDisabled = disabled || isReference;
  const hasChildren = node.type === "object" || node.type === "arrayOfObjects";
  const nameError = isDuplicate
    ? "Duplicate name"
    : node.name
      ? null
      : "Name is required";

  return (
    <div className="flex flex-col gap-2 border-l pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <Input
            aria-label="Property name"
            placeholder="property_name"
            value={node.name}
            disabled={rowDisabled}
            onChange={(event) => update({ name: event.target.value })}
            className={cn(nameError && !isReference && "border-destructive")}
          />
          {nameError && !isReference ? (
            <p className="text-destructive text-xs">{nameError}</p>
          ) : null}
        </div>

        <div className="w-40">
          {isReference ? (
            <Input aria-label="Property type" value="Reference" disabled />
          ) : (
            <Select
              value={node.type}
              disabled={disabled}
              onValueChange={(type) =>
                onNodesChange([changeNodeType(node, type as PropertyType)])
              }
            >
              <SelectTrigger aria-label="Property type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Input
          aria-label="Property description"
          placeholder="What this field contains"
          value={node.description}
          disabled={rowDisabled}
          onChange={(event) => update({ description: event.target.value })}
          className="min-w-40 flex-1"
        />

        <label className="flex items-center gap-1 text-xs">
          <Checkbox
            aria-label="Required"
            checked={node.required}
            disabled={rowDisabled}
            onCheckedChange={(checked) =>
              update({ required: checked === true })
            }
          />
          Required
        </label>

        <label className="flex items-center gap-1 text-xs">
          <Checkbox
            aria-label="Nullable"
            checked={node.nullable}
            disabled={rowDisabled}
            onCheckedChange={(checked) =>
              update({ nullable: checked === true })
            }
          />
          Nullable
        </label>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove property"
          disabled={disabled}
          onClick={() => onNodesChange([])}
        >
          <Trash className="h-4 w-4" />
        </Button>
      </div>

      {node.type === "enum" ? (
        <Input
          aria-label="Enum values"
          placeholder="value_a, value_b"
          value={node.enumValues.join(", ")}
          disabled={disabled}
          onChange={(event) =>
            update({
              enumValues: event.target.value
                .split(",")
                .map((entry) => entry.trim()),
            })
          }
          className="max-w-96"
        />
      ) : null}

      {node.type === "arrayOfScalars" ? (
        <div className="w-40">
          <Select
            value={node.itemType}
            disabled={disabled}
            onValueChange={(itemType) =>
              update({ itemType: itemType as ScalarType })
            }
          >
            <SelectTrigger aria-label="List item type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALAR_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {SCALAR_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {isReference ? (
        <p className="text-muted-foreground text-xs">
          This property reuses a shared definition and is kept as is.
        </p>
      ) : null}

      {hasChildren ? (
        <PropertyRows
          nodes={node.children}
          onNodesChange={(children) => update({ children })}
          disabled={disabled}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
};

/**
 * Renders one nesting level. A row's callback returns its replacements, so a
 * deletion is an empty list and a type change is a single rebuilt node.
 */
const PropertyRows: React.FC<RowsProps> = ({
  nodes,
  onNodesChange,
  disabled,
  depth,
}) => {
  const duplicates = duplicateNames(nodes);

  return (
    <div className="flex flex-col gap-2">
      {nodes.map((node, index) => (
        <PropertyRow
          key={node.id}
          node={node}
          isDuplicate={duplicates.has(node.name)}
          disabled={disabled}
          depth={depth}
          onNodesChange={(replacements) =>
            onNodesChange([
              ...nodes.slice(0, index),
              ...replacements,
              ...nodes.slice(index + 1),
            ])
          }
        />
      ))}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onNodesChange([...nodes, createNode()])}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add property
        </Button>
      </div>
    </div>
  );
};

export const SchemaBuilder: React.FC<SchemaBuilderProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  // The rows are the editing state: they carry identity, in-flight empty names
  // and ordering that object keys cannot express. `source` is the last schema
  // this component read or wrote, so an externally changed `value` re-parses
  // without an effect and the user's own typing is never overwritten.
  const [state, setState] = useState(() => ({
    source: value,
    root: parseSchema(value),
  }));

  if (state.source !== value) {
    setState({ source: value, root: parseSchema(value) });
  }

  const emit = (root: SchemaRoot) => {
    const serialized = serializeSchemaToString(root);
    setState({ source: serialized, root });
    onChange(serialized);
  };

  if (!state.root) {
    return (
      <p className="text-muted-foreground text-sm">
        This schema uses constructions the visual editor cannot represent. Edit
        it as JSON instead.
      </p>
    );
  }

  const root = state.root;

  return (
    <PropertyRows
      nodes={root.children}
      onNodesChange={(children) => emit({ ...root, children })}
      disabled={disabled}
      depth={0}
    />
  );
};
