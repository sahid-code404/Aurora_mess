/**
 * FORMULA EXPLANATION ENGINE (spec §58, §126)
 *
 * Generates human-readable, step-by-step calculation narratives from AST evaluation.
 * Never hardcoded — strictly derived from the AST structure and evaluated values.
 */
import { formatMinor } from "@/lib/money";
import { FormulaAst } from "./ast";
import { SYSTEM_VARIABLES_MAP, type VariableDefinitionSpec } from "./variables";

export interface ExplanationStep {
  stepNumber: number;
  description: string;
  resultMinor?: number;
  resultFormatted?: string;
}

export interface FormulaExplanation {
  outputVariableKey: string;
  outputDisplayName: string;
  friendlyExpression: string;
  finalResultFormatted: string;
  steps: ExplanationStep[];
}

export function generateFormulaExplanation(
  outputKey: string,
  ast: FormulaAst,
  variables: Record<string, number>,
  customDefs?: Record<string, { displayName: string; unit: string; valueType: string }>
): FormulaExplanation {
  const steps: ExplanationStep[] = [];
  let stepCounter = 1;

  function getLabel(key: string): string {
    if (customDefs && customDefs[key]) return customDefs[key].displayName;
    if (SYSTEM_VARIABLES_MAP[key]) return SYSTEM_VARIABLES_MAP[key].displayName;
    return key;
  }

  function formatVal(key: string, val: number): string {
    const isMoney = (customDefs && customDefs[key]?.valueType === "MONEY") ||
      SYSTEM_VARIABLES_MAP[key]?.valueType === "MONEY" ||
      key.includes("expense") || key.includes("income") || key.includes("cost") || key.includes("salary") || key.includes("charge");
    return isMoney ? formatMinor(val) : String(val);
  }

  // Walk AST to build structured step explanation
  function explainNode(node: FormulaAst): { label: string; value: number } {
    switch (node.type) {
      case "num": {
        const abs = Math.abs(node.value);
        const whole = Math.floor(abs / 100);
        const frac = String(abs % 100).padStart(2, "0");
        const formatted = `${node.value < 0 ? "-" : ""}${whole}.${frac}`;
        return { label: formatted, value: node.value };
      }
      case "var": {
        const val = variables[node.name] ?? 0;
        return { label: `${getLabel(node.name)} (${formatVal(node.name, val)})`, value: val };
      }
      case "unary": {
        const inner = explainNode(node.arg);
        const val = -inner.value;
        return { label: `-${inner.label}`, value: val };
      }
      case "assignment": {
        return explainNode(node.expression);
      }
      case "op": {
        const left = explainNode(node.left);
        const right = explainNode(node.right);
        let res = 0;
        let opDesc = "";

        if (node.op === "+") {
          res = left.value + right.value;
          opDesc = `Add ${right.label}`;
        } else if (node.op === "-") {
          res = left.value - right.value;
          opDesc = `Subtract ${right.label}`;
        } else if (node.op === "*") {
          res = Math.round((left.value * right.value) / 100);
          opDesc = `Multiply by ${right.label}`;
        } else if (node.op === "/") {
          res = right.value !== 0 ? Math.round(left.value / right.value) : 0;
          opDesc = `Divide by ${right.label}`;
        } else {
          opDesc = `Compare with ${right.label}`;
        }

        steps.push({
          stepNumber: stepCounter++,
          description: steps.length === 0
            ? `Start with ${left.label}, then ${opDesc.toLowerCase()}`
            : `${opDesc}`,
          resultMinor: res,
          resultFormatted: formatMinor(res),
        });

        return { label: `Result (${formatMinor(res)})`, value: res };
      }
      case "call": {
        if (node.fn === "ROUND") {
          const inner = explainNode(node.args[0]);
          const rounded = Math.round(inner.value);
          steps.push({
            stepNumber: stepCounter++,
            description: `Round to nearest whole paise`,
            resultMinor: rounded,
            resultFormatted: formatMinor(rounded),
          });
          return { label: `Rounded (${formatMinor(rounded)})`, value: rounded };
        }
        if (node.fn === "IF") {
          const cond = explainNode(node.args[0]);
          const branch = cond.value !== 0 ? explainNode(node.args[1]) : explainNode(node.args[2]);
          steps.push({
            stepNumber: stepCounter++,
            description: `Condition evaluated to ${cond.value !== 0 ? "true" : "false"}, selecting ${branch.label}`,
            resultMinor: branch.value,
            resultFormatted: formatMinor(branch.value),
          });
          return branch;
        }
        const innerVals = node.args.map(explainNode);
        const res = Math.max(...innerVals.map((v) => v.value));
        return { label: `${node.fn} result`, value: res };
      }
    }
  }

  const finalNode = explainNode(ast);
  const outputName = getLabel(outputKey);

  // Final summary step
  steps.push({
    stepNumber: stepCounter++,
    description: `${outputName} calculated final value`,
    resultMinor: finalNode.value,
    resultFormatted: `${formatMinor(finalNode.value)}${outputKey.includes("charge") ? " / meal" : ""}`,
  });

  return {
    outputVariableKey: outputKey,
    outputDisplayName: outputName,
    friendlyExpression: getLabel(outputKey),
    finalResultFormatted: `${formatMinor(finalNode.value)}${outputKey.includes("charge") ? " / meal" : ""}`,
    steps,
  };
}
