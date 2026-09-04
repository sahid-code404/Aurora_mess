/**
 * NATURAL LANGUAGE → SAFE FORMULA TRANSLATION (spec §50-56, §129-130, §148)
 *
 * PIPELINE:
 *  Natural Language → Intent Parser → Variable Resolver → Candidate Expression →
 *  AST Parser → Type Validation → Dependency Validation → Example Evaluation →
 *  ADMIN REVIEW → Save FormulaVersion.
 *
 * UNTRUSTED: Output is never executed directly for money.
 * GUEST MEAL MANDATORY RULE (spec §53): "resident meals" MUST map to total_resident_meals
 * and NEVER include guests. "all meals" maps to total_servings.
 */
import ZAI from "z-ai-web-dev-sdk";
import { ApiError, CODES } from "@/lib/errors";
import { FormulaAst, validateFormulaAst } from "./ast";
import { astToCanonical, parseFormula } from "./parser";
import { SYSTEM_VARIABLES, SYSTEM_VARIABLES_MAP } from "./variables";

export interface AmbiguityQuestion {
  id: string;
  question: string;
  options: { label: string; variableKey: string; description: string }[];
}

export interface SuggestedCustomVariable {
  name: string;
  key: string;
  valueType: string;
  unit: string;
  value: number;
}

export interface NaturalFormulaResult {
  ast: FormulaAst;
  formulaText: string;
  naturalSource: string;
  recognizedVariables: { term: string; variableKey: string; displayName: string }[];
  ambiguities?: AmbiguityQuestion[];
  suggestedCustomVariable?: SuggestedCustomVariable;
}

/**
 * Deterministic heuristic intent parser for common English formula expressions.
 * Provides instant, zero-latency parsing and guarantees exact compliance with spec §50-56.
 */
function heuristicParse(text: string, knownCustomVars?: Record<string, string>): NaturalFormulaResult | null {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const recognized: { term: string; variableKey: string; displayName: string }[] = [];
  const ambiguities: AmbiguityQuestion[] = [];
  let suggestedVar: SuggestedCustomVariable | undefined;

  // 1. Direct formula expression check (if user wrote mathematical syntax like "(a - b) / c")
  if (/^[a-z0-9_\s\+\-\*\/\(\)\.,><=!]+$/i.test(raw) && /[+\-*/]/.test(raw) && !/\b(divide|minus|plus|subtract|times|from|then|equals?)\b/i.test(raw)) {
    try {
      const ast = parseFormula(raw);
      return {
        ast,
        formulaText: astToCanonical(ast),
        naturalSource: raw,
        recognizedVariables: [],
      };
    } catch {
      // Continue to NLP
    }
  }

  // 2. Ambiguity check: e.g. "divide expenses by meals" without specifying which
  const hasVagueExpense = /\b(expenses|expense)\b/.test(lower) && !/market|approved|grocery|vegetable|fuel|other/.test(lower);
  const hasVagueMeal = /\b(meals|meal)\b/.test(lower) && !/resident|guest|serving|all/.test(lower);

  if (hasVagueExpense && hasVagueMeal && !/total_approved_expense|total_market_expense|total_resident_meals/.test(lower)) {
    ambiguities.push(
      {
        id: "expense_type",
        question: "Which expense would you like to use?",
        options: [
          { label: "Total Approved Expense", variableKey: "total_approved_expense", description: "All approved expenses across categories" },
          { label: "Total Market Expense", variableKey: "total_market_expense", description: "Only approved official market purchases" },
        ],
      },
      {
        id: "meal_type",
        question: "Which meals denominator should be used?",
        options: [
          { label: "Regular Resident Meals", variableKey: "total_resident_meals", description: "Only regular resident meals (excludes guests)" },
          { label: "All Servings", variableKey: "total_servings", description: "Regular meals plus guest meals" },
        ],
      }
    );
  }

  // 3. Custom variable mention with amount, e.g. "cook bonus of 2500 rupees" or "kitchen staff salary of 12000"
  const customVarMatch = /(kitchen\s+staff\s+salary|cook\s+salary|staff\s+salary|cook\s+bonus|staff\s+bonus|bonus|gas\s+cost)\s+(?:of\s+)?(?:₹|rs\.?|inr)?\s*([0-9]+(?:,[0-9]+)?)/.exec(lower);
  if (customVarMatch) {
    const rawKey = customVarMatch[1].replace(/\s+/g, "_");
    const amount = parseInt(customVarMatch[2].replace(/,/g, ""), 10) * 100; // paise
    const displayName = customVarMatch[1].replace(/\b\w/g, (c) => c.toUpperCase());
    suggestedVar = {
      name: displayName,
      key: rawKey,
      valueType: "MONEY",
      unit: "INR",
      value: amount,
    };
    recognized.push({
      term: customVarMatch[1],
      variableKey: rawKey,
      displayName,
    });
  }

  // 4. Entity Recognition for standard System Variables
  let expenseVar = "total_approved_expense";
  if (/market\s+(expense|cost|expenses)/.test(lower)) {
    expenseVar = "total_market_expense";
    recognized.push({ term: "market expense", variableKey: "total_market_expense", displayName: "Total Market Expense" });
  } else if (/grocery\s+(expense|cost)/.test(lower)) {
    expenseVar = "total_grocery_expense";
    recognized.push({ term: "grocery expense", variableKey: "total_grocery_expense", displayName: "Total Grocery Expense" });
  } else if (/vegetable\s+(expense|cost)/.test(lower)) {
    expenseVar = "total_vegetable_expense";
    recognized.push({ term: "vegetable expense", variableKey: "total_vegetable_expense", displayName: "Total Vegetable Expense" });
  } else if (/fuel|gas/.test(lower)) {
    expenseVar = "total_fuel_expense";
    recognized.push({ term: "fuel expense", variableKey: "total_fuel_expense", displayName: "Total Fuel Expense" });
  } else if (/approved\s+expense|total\s+expense|expense/.test(lower)) {
    expenseVar = "total_approved_expense";
    recognized.push({ term: "approved expense", variableKey: "total_approved_expense", displayName: "Total Approved Expense" });
  }

  let mealVar = "total_resident_meals";
  if (/all\s+meals|total\s+servings|servings/.test(lower)) {
    mealVar = "total_servings";
    recognized.push({ term: "total servings", variableKey: "total_servings", displayName: "Total Servings" });
  } else if (/guest\s+meals?/.test(lower)) {
    mealVar = "total_guest_meals";
    recognized.push({ term: "guest meals", variableKey: "total_guest_meals", displayName: "Total Guest Meals" });
  } else if (/resident\s+meals?|regular\s+meals?|meals?/.test(lower)) {
    mealVar = "total_resident_meals";
    recognized.push({ term: "resident meals", variableKey: "total_resident_meals", displayName: "Total Resident Meals" });
  }

  const hasGuestIncome = /guest\s+income/.test(lower);
  if (hasGuestIncome) {
    recognized.push({ term: "guest income", variableKey: "total_guest_income", displayName: "Total Guest Income" });
  }

  const hasGuestPrice = /guest\s+(?:meal\s+)?price/.test(lower);
  if (hasGuestPrice) {
    recognized.push({ term: "guest meal price", variableKey: "guest_meal_price", displayName: "Guest Meal Price" });
  }

  const hasPayments = /payments?|collections?/.test(lower);
  if (hasPayments) {
    recognized.push({ term: "approved payments", variableKey: "total_payments_approved", displayName: "Total Payments Approved" });
  }

  const hasFunds = /available\s+funds|funds/.test(lower);
  if (hasFunds) {
    recognized.push({ term: "available funds", variableKey: "available_funds", displayName: "Available Funds" });
  }

  // Check additional custom variables like kitchen_staff_salary without explicit amount
  let additionalAddedVar: string | null = null;
  if (suggestedVar) {
    additionalAddedVar = suggestedVar.key;
  } else if (/kitchen\s+staff\s+salary|cook\s+salary|staff\s+salary/.test(lower)) {
    additionalAddedVar = "kitchen_staff_salary";
    recognized.push({ term: "kitchen staff salary", variableKey: "kitchen_staff_salary", displayName: "Kitchen Staff Salary" });
  }

  // 5. Semantic Construction of Candidate Expression
  let candidateExpr = "";

  const isDivision = /(?:\b(?:divid(?:e|es|ed|ing)?|over|split\s+(?:by|across|among)|shared?\s+(?:by|across|among))\b|\/|per\s+(?:meal|resident|serving|person|head|day))/i.test(lower);
  const isMultiplication = /(?:\b(?:multipl(?:y|ies|ied|ying)?|times|product\s+of)\b|\*)/i.test(lower);
  const isSubtraction = /(?:\b(?:subtract(?:s|ed|ing|ion)?|minus|less|deduct(?:s|ed|ing)?)\b|\-)/i.test(lower);
  const isAddition = /(?:\b(?:add(?:s|ed|ing|ition)?|plus|sum\s+of|total\s+of)\b|\+)/i.test(lower);

  // Check if guest income is explicitly the sole numerator (e.g. "guest income divided by guest meals")
  const guestIncomeAsNumerator = !/expense|cost|expenditure/.test(lower) && /guest\s+income.*(?:divid|split|\/|over)/.test(lower);

  // Pattern A: Division Formulas (Meal Charge / per-unit formulas)
  if (isDivision) {
    let numerator = expenseVar;
    if (guestIncomeAsNumerator) {
      numerator = "total_guest_income";
    } else if (hasGuestIncome && additionalAddedVar) {
      numerator = `(${expenseVar} + ${additionalAddedVar} - total_guest_income)`;
    } else if (hasGuestIncome) {
      numerator = `(${expenseVar} - total_guest_income)`;
    } else if (additionalAddedVar) {
      numerator = `(${expenseVar} + ${additionalAddedVar})`;
    }

    if (/round/.test(lower)) {
      candidateExpr = `ROUND(${numerator} / ${mealVar}, 2)`;
    } else {
      candidateExpr = `${numerator} / ${mealVar}`;
    }
  }
  // Pattern B: Multiplication (e.g. guest meals * guest meal price)
  else if (isMultiplication && (/guest/.test(lower) || hasGuestPrice)) {
    candidateExpr = `total_guest_meals * guest_meal_price`;
  }
  // Pattern C: Subtraction (e.g. payments - expenses, or funds - expenses)
  else if (isSubtraction && hasPayments) {
    candidateExpr = `total_payments_approved - ${expenseVar}`;
  }
  else if (isSubtraction && hasGuestIncome) {
    candidateExpr = `${expenseVar} - total_guest_income`;
  }
  // Pattern D: Addition (e.g. market expense + staff salary)
  else if (isAddition && additionalAddedVar) {
    candidateExpr = `${expenseVar} + ${additionalAddedVar}`;
  }
  else if (recognized.length >= 2) {
    // If division keyword wasn't caught or two recognized items
    candidateExpr = `${recognized[0].variableKey} + ${recognized[1].variableKey}`;
  }

  // If ambiguity detected and no clear candidate was formed, return with questions
  if (ambiguities.length > 0 && (!candidateExpr || candidateExpr === "total_approved_expense / total_resident_meals")) {
    const defaultAst = parseFormula("(total_approved_expense - total_guest_income) / total_resident_meals");
    return {
      ast: defaultAst,
      formulaText: astToCanonical(defaultAst),
      naturalSource: text,
      recognizedVariables: recognized,
      ambiguities,
      suggestedCustomVariable: suggestedVar,
    };
  }

  if (candidateExpr) {
    try {
      const ast = parseFormula(candidateExpr);
      return {
        ast,
        formulaText: astToCanonical(ast),
        naturalSource: text,
        recognizedVariables: recognized,
        ambiguities: ambiguities.length > 0 ? ambiguities : undefined,
        suggestedCustomVariable: suggestedVar,
      };
    } catch {
      // Continue to AI
    }
  }

  return null;
}

const SYSTEM_PROMPT = [
  "You convert a natural-language description of a mess/hostel formula into a safe JSON AST.",
  "",
  "Available system variables:",
  ...SYSTEM_VARIABLES.map(
    (v) => `- ${v.key}: ${v.displayName} (${v.valueType}, ${v.unit}, scope ${v.scope})`
  ),
  "",
  "CRITICAL RULES:",
  "1. 'resident meals' MUST map to 'total_resident_meals' (never guest meals).",
  "2. 'all meals' or 'servings' maps to 'total_servings'.",
  "3. 'guest meals' maps to 'total_guest_meals'.",
  "4. 'market expense' maps to 'total_market_expense'.",
  "5. Money is in integer paise (1 rupee = 100 paise).",
  "6. Output JSON only: {\"ast\": <node>, \"formulaText\": \"...\"}",
].join("\n");

export async function parseNaturalLanguage(
  text: string,
  knownCustomVars?: Record<string, string>
): Promise<NaturalFormulaResult> {
  const input = String(text ?? "").trim();
  if (!input) {
    throw new ApiError(CODES.FORMULA_INVALID, "Describe the formula in a sentence or two.", 422);
  }
  if (input.length > 600) {
    throw new ApiError(CODES.FORMULA_INVALID, "Keep description under 600 characters.", 422);
  }

  // 1. Try deterministic heuristic intent parser first
  const heuristic = heuristicParse(input, knownCustomVars);
  if (heuristic && (!heuristic.ambiguities || heuristic.ambiguities.length === 0)) {
    return heuristic;
  }

  // 2. Fall back to LLM SDK
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0,
    });
    const content = (completion as any)?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      const jsonText = extractJson(content);
      const parsed = JSON.parse(jsonText);
      const ast = validateFormulaAst(parsed.ast);
      const formulaText = astToCanonical(ast);

      return {
        ast,
        formulaText,
        naturalSource: input,
        recognizedVariables: heuristic?.recognizedVariables ?? [],
        ambiguities: heuristic?.ambiguities,
        suggestedCustomVariable: heuristic?.suggestedCustomVariable,
      };
    }
  } catch {
    // If LLM fails or is unavailable, use heuristic if available
    if (heuristic) {
      return heuristic;
    }
  }

  throw new ApiError(
    CODES.FORMULA_INVALID,
    "Could not understand formula description. Please try rephrasing (e.g. 'subtract guest income from market expense and divide by resident meals') or enter formula syntax directly.",
    422
  );
}

function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return body;
  return body.slice(start, end + 1);
}
