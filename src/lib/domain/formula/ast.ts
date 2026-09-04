/**
 * FORMULA AST — the ONLY data structure that is ever evaluated (spec §23-27, §45-51).
 *
 * SECURITY MODEL:
 *  - Evaluator consumes FormulaAst exclusively. Raw text is converted by the parser.
 *  - There is NO eval() / new Function() anywhere in the formula engine (spec §27).
 *  - validateFormulaAst() normalizes untrusted input (parser output OR LLM JSON)
 *    into a safe, structurally-valid AST with arity-checked functions and safe bounds.
 *  - MONEY: all numeric values for currency are integer minor units (paise).
 */
import { ApiError, CODES } from "@/lib/errors";
import { isValidVariableKey } from "./variables";

export type FormulaOperator = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type FormulaFunctionName = "SUM" | "MIN" | "MAX" | "ROUND" | "IF" | "ABS" | "CEIL" | "FLOOR";

export type FormulaAst =
  | { type: "num"; value: number }
  | { type: "var"; name: string }
  | { type: "unary"; op: "-"; arg: FormulaAst }
  | { type: "op"; op: FormulaOperator; left: FormulaAst; right: FormulaAst }
  | { type: "call"; fn: FormulaFunctionName; args: FormulaAst[] }
  | { type: "assignment"; target: string; expression: FormulaAst };

/** Node and depth budgets guard against runaway ASTs. */
export const MAX_AST_NODES = 300;
export const MAX_AST_DEPTH = 30;
export const MAX_AST_ABS = 2 ** 48;

const ARG_RULES: Record<FormulaFunctionName, { min: number; max: number }> = {
  SUM: { min: 1, max: 20 },
  MIN: { min: 1, max: 20 },
  MAX: { min: 1, max: 20 },
  ROUND: { min: 1, max: 2 }, // ROUND(x) or ROUND(x, decimals)
  IF: { min: 3, max: 3 },    // IF(cond, thenVal, elseVal)
  ABS: { min: 1, max: 1 },
  CEIL: { min: 1, max: 1 },
  FLOOR: { min: 1, max: 1 },
};

function invalid(message: string): ApiError {
  return new ApiError(CODES.FORMULA_INVALID, message, 422);
}

type Budget = { nodes: number };

/**
 * Validate an untrusted object into a normalized FormulaAst.
 * Throws FORMULA_INVALID ApiErrors if invalid.
 */
export function validateFormulaAst(input: unknown, allowedVariables?: Set<string> | Record<string, unknown>): FormulaAst {
  const budget: Budget = { nodes: 0 };
  const allowedSet = allowedVariables instanceof Set
    ? allowedVariables
    : allowedVariables
      ? new Set(Object.keys(allowedVariables))
      : null;
  return validateNode(input, 0, budget, allowedSet);
}

function validateNode(
  input: unknown,
  depth: number,
  budget: Budget,
  allowedVariables: Set<string> | null
): FormulaAst {
  budget.nodes += 1;
  if (budget.nodes > MAX_AST_NODES) {
    throw invalid("This formula is too complex — simplify it and try again.");
  }
  if (depth > MAX_AST_DEPTH) {
    throw invalid("This formula is nested too deeply.");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("The formula structure is not valid.");
  }
  const raw = input as Record<string, unknown>;

  switch (raw.type) {
    case "num": {
      const value = raw.value;
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= MAX_AST_ABS) {
        throw invalid("Numbers must be within the supported numerical range.");
      }
      return { type: "num", value };
    }
    case "var": {
      const name = raw.name;
      if (typeof name !== "string" || name.length === 0) {
        throw invalid("The formula references an unnamed variable.");
      }
      const lower = name.toLowerCase();
      if (!isValidVariableKey(lower)) {
        throw invalid(`Variable name '${name}' must be lowercase snake_case.`);
      }
      if (allowedVariables && !allowedVariables.has(lower)) {
        throw new ApiError(
          CODES.FORMULA_UNKNOWN_VARIABLE,
          `'${lower}' is not one of the available variables.`,
          422
        );
      }
      return { type: "var", name: lower };
    }
    case "unary": {
      if (raw.op !== "-") {
        throw invalid(`'${String(raw.op)}' is not a supported unary operator.`);
      }
      if (!raw.arg) {
        throw invalid("Unary operator requires an argument.");
      }
      const arg = validateNode(raw.arg, depth + 1, budget, allowedVariables);
      return { type: "unary", op: "-", arg };
    }
    case "op": {
      const op = raw.op as FormulaOperator;
      const validOps = ["+", "-", "*", "/", "==", "!=", "<", "<=", ">", ">="];
      if (!validOps.includes(op)) {
        throw invalid(`'${String(op)}' is not a supported operator.`);
      }
      if (raw.left === undefined || raw.right === undefined) {
        throw invalid("Binary operators require both a left and right side.");
      }
      const left = validateNode(raw.left, depth + 1, budget, allowedVariables);
      const right = validateNode(raw.right, depth + 1, budget, allowedVariables);
      return { type: "op", op, left, right };
    }
    case "call": {
      const fn = String(raw.fn).toUpperCase() as FormulaFunctionName;
      if (!Object.keys(ARG_RULES).includes(fn)) {
        throw invalid(`'${String(fn)}' is not a supported function.`);
      }
      const args = raw.args;
      if (!Array.isArray(args)) {
        throw invalid(`Function ${fn} requires arguments as a list.`);
      }
      const rule = ARG_RULES[fn];
      if (args.length < rule.min || args.length > rule.max) {
        if (rule.min === rule.max) {
          throw invalid(`${fn} takes exactly ${rule.min} argument${rule.min === 1 ? "" : "s"}.`);
        }
        throw invalid(`${fn} takes between ${rule.min} and ${rule.max} arguments.`);
      }
      const validatedArgs = args.map((arg) => validateNode(arg, depth + 1, budget, allowedVariables));
      return { type: "call", fn, args: validatedArgs };
    }
    case "assignment": {
      const target = raw.target;
      if (typeof target !== "string" || !isValidVariableKey(target.toLowerCase())) {
        throw invalid("Assignment target must be a valid lowercase snake_case variable key.");
      }
      if (!raw.expression) {
        throw invalid("Assignment requires an expression.");
      }
      const expression = validateNode(raw.expression, depth + 1, budget, allowedVariables);
      return { type: "assignment", target: target.toLowerCase(), expression };
    }
    default:
      throw invalid("The formula structure is not valid.");
  }
}

/** Recursively extract all referenced variable keys from an AST. */
export function extractVariableNames(ast: FormulaAst): string[] {
  const vars = new Set<string>();
  function walk(node: FormulaAst) {
    switch (node.type) {
      case "var":
        vars.add(node.name);
        break;
      case "unary":
        walk(node.arg);
        break;
      case "op":
        walk(node.left);
        walk(node.right);
        break;
      case "call":
        for (const arg of node.args) walk(arg);
        break;
      case "assignment":
        walk(node.expression);
        break;
    }
  }
  walk(ast);
  return Array.from(vars);
}
