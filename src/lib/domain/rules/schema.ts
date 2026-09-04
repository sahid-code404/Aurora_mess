import { z } from "zod";
import type { StructuredDecisionRule } from "@/lib/domain/rules/engine";

const ruleScalarSchema = z.union([z.string().max(250), z.number().finite(), z.boolean(), z.null()]);

const factOperandSchema = z
  .object({
    source: z.literal("FACT"),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  })
  .strict();

const literalOperandSchema = z
  .object({
    source: z.literal("LITERAL"),
    value: ruleScalarSchema,
  })
  .strict();

export const ruleOperandSchema = z.discriminatedUnion("source", [factOperandSchema, literalOperandSchema]);

export const ruleOperatorSchema = z.enum([
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "IN",
  "BETWEEN",
  "IS_TRUE",
  "IS_FALSE",
]);

export const ruleConditionSchema = z
  .object({
    left: ruleOperandSchema,
    operator: ruleOperatorSchema,
    right: ruleOperandSchema.optional(),
    values: z.array(ruleOperandSchema).max(25).optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const binary = ["==", "!=", ">", ">=", "<", "<="].includes(condition.operator);
    if (binary && !condition.right) {
      ctx.addIssue({ code: "custom", message: `${condition.operator} requires a right operand.` });
    }
    if ((condition.operator === "IS_TRUE" || condition.operator === "IS_FALSE") && (condition.right || condition.values)) {
      ctx.addIssue({ code: "custom", message: `${condition.operator} does not accept right/values operands.` });
    }
    if (condition.operator === "IN" && (!condition.values || condition.values.length < 1)) {
      ctx.addIssue({ code: "custom", message: "IN requires at least one value." });
    }
    if (condition.operator === "BETWEEN" && condition.values?.length !== 2) {
      ctx.addIssue({ code: "custom", message: "BETWEEN requires exactly two values." });
    }
  });

export const ruleGroupSchema = z
  .object({
    logic: z.enum(["AND", "OR"]),
    conditions: z.array(ruleConditionSchema).min(1).max(30),
  })
  .strict();

export const structuredRuleBaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(100),
    version: z.number().int().min(1).max(1_000_000),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    when: ruleGroupSchema,
  })
  .strict();

/**
 * Validate untrusted JSON into the exact structured rule shape. Unknown fields
 * are rejected, not stripped, so executable-looking payloads cannot hide next
 * to valid rule data.
 */
export function parseStructuredRuleSet<Result>(
  input: unknown,
  resultSchema: z.ZodType<Result>
): StructuredDecisionRule<Result>[] {
  const ruleSchema = structuredRuleBaseSchema.extend({ result: resultSchema }).strict();
  return z.array(ruleSchema).min(1).max(50).parse(input) as StructuredDecisionRule<Result>[];
}
