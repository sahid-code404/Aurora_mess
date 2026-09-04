/**
 * FORMULA EVALUATOR (spec §23-27, §47-48) — safe interpretation of a validated FormulaAst.
 *
 * MONEY SAFETY: everything stays in integer minor units (paise).
 *  - "+" and "-" are integer sums (guarded for safe-integer results).
 *  - "*" uses multiplyRoundHalfUp from @/lib/money.
 *  - "/" uses divideMinorRoundHalfUp from @/lib/money; denominator 0 throws
 *    FORMULA_DIVIDE_BY_ZERO (HTTP 422) with exact reason.
 *  - "ROUND" rounds to whole paise or specified decimal precision.
 *  - No eval() or dynamic code execution anywhere.
 */
import { ApiError, CODES } from "@/lib/errors";
import { divideMinorRoundHalfUp, formatMinor, multiplyRoundHalfUp } from "@/lib/money";
import { FormulaAst, MAX_AST_ABS } from "./ast";
import { SYSTEM_VARIABLES_MAP, VARIABLE_ALIASES, type VariableUnit } from "./variables";

export interface FormulaEvaluation {
  value: number;
  steps: string[];
}

function checkSafeInteger(n: number): number {
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || Math.abs(n) >= MAX_AST_ABS) {
    throw new ApiError(
      CODES.FORMULA_INVALID,
      "The formula produced a value outside the supported numerical envelope.",
      422
    );
  }
  return n;
}

/** Evaluate a validated AST against resolved variable values. */
export function evaluateFormula(ast: FormulaAst, variables: Record<string, number>): number {
  return evalNode(ast, variables, undefined, 0);
}

/** Evaluate and capture human-readable calculation steps. */
export function evaluateFormulaWithSteps(
  ast: FormulaAst,
  variables: Record<string, number>
): FormulaEvaluation {
  const steps: string[] = [];
  const value = evalNode(ast, variables, steps, 0);
  return { value, steps };
}

function evalNode(
  node: FormulaAst,
  variables: Record<string, number>,
  steps: string[] | undefined,
  depth: number
): number {
  if (depth > 40) {
    throw new ApiError(CODES.FORMULA_INVALID, "This formula is nested too deeply.", 422);
  }

  switch (node.type) {
    case "num":
      return checkSafeInteger(node.value);

    case "var": {
      let val = variables[node.name];
      if (val === undefined) {
        const canonical = VARIABLE_ALIASES[node.name];
        if (canonical && variables[canonical] !== undefined) {
          val = variables[canonical];
        } else {
          for (const [alias, target] of Object.entries(VARIABLE_ALIASES)) {
            if (target === node.name && variables[alias] !== undefined) {
              val = variables[alias];
              break;
            }
          }
        }
      }
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new ApiError(
          CODES.FORMULA_UNKNOWN_VARIABLE,
          `No value is available for '${node.name}' in this context.`,
          422
        );
      }
      return checkSafeInteger(val);
    }

    case "unary": {
      const inner = evalNode(node.arg, variables, steps, depth + 1);
      const val = -inner;
      return checkSafeInteger(val);
    }

    case "assignment": {
      return evalNode(node.expression, variables, steps, depth + 1);
    }

    case "op": {
      const left = evalNode(node.left, variables, steps, depth + 1);
      const right = evalNode(node.right, variables, steps, depth + 1);
      let value: number;

      switch (node.op) {
        case "+":
          value = left + right;
          break;
        case "-":
          value = left - right;
          break;
        case "*":
          value = multiplyRoundHalfUp(left, right);
          break;
        case "/": {
          if (right === 0) {
            const denomLabel = node.right.type === "var"
              ? (SYSTEM_VARIABLES_MAP[node.right.name]?.displayName ?? node.right.name)
              : "denominator";
            throw new ApiError(
              CODES.FORMULA_DIVIDE_BY_ZERO,
              `Formula cannot be calculated because ${denomLabel} is 0.`,
              422
            );
          }
          value = divideMinorRoundHalfUp(left, right);
          break;
        }
        case "==":
          value = left === right ? 1 : 0;
          break;
        case "!=":
          value = left !== right ? 1 : 0;
          break;
        case "<":
          value = left < right ? 1 : 0;
          break;
        case "<=":
          value = left <= right ? 1 : 0;
          break;
        case ">":
          value = left > right ? 1 : 0;
          break;
        case ">=":
          value = left >= right ? 1 : 0;
          break;
      }

      value = checkSafeInteger(value);
      if (steps && (node.op === "+" || node.op === "-" || node.op === "*" || node.op === "/")) {
        pushStep(steps, node, value);
      }
      return value;
    }

    case "call": {
      let value: number;
      if (node.fn === "IF") {
        const cond = evalNode(node.args[0], variables, steps, depth + 1);
        value = evalNode(cond !== 0 ? node.args[1] : node.args[2], variables, steps, depth + 1);
      } else if (node.fn === "ROUND") {
        const x = evalNode(node.args[0], variables, steps, depth + 1);
        const decimals = node.args.length > 1 ? evalNode(node.args[1], variables, steps, depth + 1) : 0;
        if (decimals === 0) {
          value = x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
        } else {
          const factor = Math.pow(10, decimals);
          value = Math.round(x * factor) / factor;
        }
      } else if (node.fn === "SUM") {
        value = 0;
        for (const arg of node.args) {
          value = checkSafeInteger(value + evalNode(arg, variables, steps, depth + 1));
        }
      } else if (node.fn === "MIN") {
        const vals = node.args.map((a) => evalNode(a, variables, steps, depth + 1));
        value = Math.min(...vals);
      } else if (node.fn === "MAX") {
        const vals = node.args.map((a) => evalNode(a, variables, steps, depth + 1));
        value = Math.max(...vals);
      } else if (node.fn === "ABS") {
        const x = evalNode(node.args[0], variables, steps, depth + 1);
        value = Math.abs(x);
      } else if (node.fn === "CEIL") {
        const x = evalNode(node.args[0], variables, steps, depth + 1);
        value = Math.ceil(x);
      } else if (node.fn === "FLOOR") {
        const x = evalNode(node.args[0], variables, steps, depth + 1);
        value = Math.floor(x);
      } else {
        throw new ApiError(CODES.FORMULA_INVALID, `Unsupported function: ${node.fn}`, 422);
      }

      value = checkSafeInteger(value);
      if (steps) pushStep(steps, node, value);
      return value;
    }
  }

  throw new ApiError(CODES.FORMULA_INVALID, "This formula could not be evaluated.", 422);
}

function pushStep(steps: string[], node: FormulaAst, value: number): void {
  if (steps.length >= 16) return;
  steps.push(`${toHumanPreview(node)} = ${formatNodeValue(node, value)}`);
}

function formatNodeValue(node: FormulaAst, value: number): string {
  return inferUnit(node) === "INR" ? formatMinor(value) : String(value);
}

function inferUnit(node: FormulaAst): VariableUnit {
  switch (node.type) {
    case "num":
      return "INR";
    case "var":
      return SYSTEM_VARIABLES_MAP[node.name]?.unit ?? "INR";
    case "unary":
      return inferUnit(node.arg);
    case "assignment":
      return inferUnit(node.expression);
    case "op":
      if (node.op === "*" || node.op === "/") return "INR";
      return inferUnit(node.left);
    case "call":
      return "INR";
  }
}

const OP_SYMBOLS: Record<string, string> = {
  "+": "+",
  "-": "−",
  "*": "×",
  "/": "÷",
  "==": "==",
  "!=": "≠",
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
};

/**
 * Human-friendly formula rendering using readable names.
 * e.g. "(Total Market Expense − Total Guest Income) ÷ Total Resident Meals"
 */
export function toHumanPreview(ast: FormulaAst): string {
  return renderNode(ast);
}

function renderNode(node: FormulaAst): string {
  switch (node.type) {
    case "num": {
      const abs = Math.abs(node.value);
      const whole = Math.floor(abs / 100);
      const frac = String(abs % 100).padStart(2, "0");
      return `${node.value < 0 ? "−" : ""}${whole}.${frac}`;
    }
    case "var":
      return SYSTEM_VARIABLES_MAP[node.name]?.displayName ?? node.name;
    case "unary":
      return `−${renderNode(node.arg)}`;
    case "assignment":
      return `${SYSTEM_VARIABLES_MAP[node.target]?.displayName ?? node.target} = ${renderNode(node.expression)}`;
    case "op": {
      const left = node.left.type === "op" ? `(${renderNode(node.left)})` : renderNode(node.left);
      const right = node.right.type === "op" ? `(${renderNode(node.right)})` : renderNode(node.right);
      return `${left} ${OP_SYMBOLS[node.op] ?? node.op} ${right}`;
    }
    case "call":
      return `${node.fn}(${node.args.map(renderNode).join(", ")})`;
  }
}
