/**
 * FORMULA PARSER — tokenizer + recursive descent (spec §23-27, §80-81).
 * NO eval / new Function — ever. The output is a FormulaAst which is then
 * run through validateFormulaAst.
 *
 * Grammar:
 *   assignmentOrExpr := (IDENT "=")? comparison
 *   comparison       := expression (("==" | "!=" | "<=" | ">=" | "<" | ">") expression)?
 *   expression       := term (("+" | "-") term)*
 *   term             := unary (("*" | "/") unary)*
 *   unary            := ("-")? primary
 *   primary          := NUMBER | VARIABLE | FUNCTION "(" (expression ("," expression)*)? ")" | "(" assignmentOrExpr ")"
 */
import { ApiError, CODES } from "@/lib/errors";
import { parseDecimalToMinor } from "@/lib/money";
import { FormulaAst, FormulaFunctionName, FormulaOperator, validateFormulaAst } from "./ast";
import { normalizeVariableKey } from "./variables";

type TokenKind =
  | "num"
  | "ident"
  | "op"
  | "eq"
  | "cmp"
  | "lparen"
  | "rparen"
  | "comma";

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
}

const FUNCTIONS: FormulaFunctionName[] = ["SUM", "MIN", "MAX", "ROUND", "IF", "ABS", "CEIL", "FLOOR"];
const CMP_OPERATORS = ["==", "!=", "<=", ">=", "<", ">"] as const;

function invalid(message: string): ApiError {
  return new ApiError(CODES.FORMULA_INVALID, message, 422);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Comparison operators ==, !=, <=, >=
    const twoChars = source.slice(i, i + 2);
    if (twoChars === "==" || twoChars === "!=" || twoChars === "<=" || twoChars === ">=") {
      tokens.push({ kind: "cmp", text: twoChars, pos: i });
      i += 2;
      continue;
    }
    // Single-char comparisons <, >
    if (ch === "<" || ch === ">") {
      tokens.push({ kind: "cmp", text: ch, pos: i });
      i += 1;
      continue;
    }
    // Assignment =
    if (ch === "=") {
      tokens.push({ kind: "eq", text: "=", pos: i });
      i += 1;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i));
      if (!m) throw invalid("The formula contains an invalid number.");
      tokens.push({ kind: "num", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    // Identifiers
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      if (!m) throw invalid("The formula contains an invalid name.");
      tokens.push({ kind: "ident", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    // Arithmetic operators
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma", text: ch, pos: i });
      i += 1;
      continue;
    }
    throw invalid(`'${ch}' is not allowed in a formula.`);
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private peekNext(): Token | null {
    return this.tokens[this.pos + 1] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw invalid("The formula ends unexpectedly — check for a missing value or closing parenthesis.");
    this.pos += 1;
    return token;
  }

  parse(): FormulaAst {
    const first = this.peek();
    const second = this.peekNext();
    if (first?.kind === "ident" && second?.kind === "eq") {
      this.next(); // ident
      this.next(); // =
      const target = normalizeVariableKey(first.text);
      const expression = this.parseComparison();
      return { type: "assignment", target, expression };
    }
    return this.parseComparison();
  }

  private parseComparison(): FormulaAst {
    let left = this.parseExpression();
    const peek = this.peek();
    if (peek?.kind === "cmp") {
      const op = this.next().text as FormulaOperator;
      const right = this.parseExpression();
      left = { type: "op", op, left, right };
    }
    return left;
  }

  parseExpression(): FormulaAst {
    let left = this.parseTerm();
    for (;;) {
      const peek = this.peek();
      if (peek?.kind === "op" && (peek.text === "+" || peek.text === "-")) {
        const op = this.next().text as "+" | "-";
        const right = this.parseTerm();
        left = { type: "op", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseTerm(): FormulaAst {
    let left = this.parseUnary();
    for (;;) {
      const peek = this.peek();
      if (peek?.kind === "op" && (peek.text === "*" || peek.text === "/")) {
        const op = this.next().text as "*" | "/";
        const right = this.parseUnary();
        left = { type: "op", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): FormulaAst {
    const peek = this.peek();
    if (peek?.kind === "op" && peek.text === "-") {
      this.next();
      const arg = this.parsePrimary();
      return { type: "unary", op: "-", arg };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaAst {
    const token = this.next();
    if (token.kind === "num") {
      const minor = parseDecimalToMinor(token.text);
      if (minor === null) {
        const floatVal = parseFloat(token.text);
        if (Number.isFinite(floatVal)) {
          return { type: "num", value: Math.round(floatVal * 100) };
        }
        throw invalid("Numbers can have at most two decimal places.");
      }
      return { type: "num", value: minor };
    }

    if (token.kind === "ident") {
      const peek = this.peek();
      if (peek?.kind === "lparen") {
        const fn = token.text.toUpperCase() as FormulaFunctionName;
        if (!FUNCTIONS.includes(fn)) {
          throw invalid(`'${token.text}' is not a supported function.`);
        }
        this.next(); // consume "("
        const args: FormulaAst[] = [];
        if (this.peek()?.kind === "rparen") {
          this.next();
        } else {
          for (;;) {
            args.push(this.parseComparison());
            const after = this.peek();
            if (after?.kind === "comma") {
              this.next();
              continue;
            }
            if (after?.kind === "rparen") {
              this.next();
              break;
            }
            throw invalid(`Function ${fn} is missing a comma or closing parenthesis.`);
          }
        }
        return { type: "call", fn, args };
      }

      // Variable identifier
      const key = normalizeVariableKey(token.text);
      return { type: "var", name: key };
    }

    if (token.kind === "lparen") {
      const inner = this.parseComparison();
      const closing = this.peek();
      if (closing?.kind !== "rparen") {
        throw invalid("A closing parenthesis ')' is missing.");
      }
      this.next();
      return inner;
    }

    throw invalid(`'${token.text}' cannot start an expression here.`);
  }

  expectEof(): void {
    const peek = this.peek();
    if (peek) {
      throw invalid(`'${peek.text}' is unexpected here — check the formula syntax.`);
    }
  }
}

/** Parse raw formula text into a validated, normalized AST. */
export function parseFormula(source: string, allowedVariables?: Set<string>): FormulaAst {
  const text = String(source ?? "").trim();
  if (!text) throw invalid("Enter a formula.");
  if (text.length > 2500) throw invalid("The formula is too long.");
  const tokens = tokenize(text);
  if (tokens.length === 0) throw invalid("Enter a formula.");
  const parser = new Parser(tokens);
  const ast = parser.parse();
  parser.expectEof();
  return validateFormulaAst(ast, allowedVariables);
}

/** Render a minor-unit integer as a plain decimal string ("123.45"). */
export function minorToDecimalString(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Canonical formula text representation for hashing and storage. */
export function astToCanonical(ast: FormulaAst): string {
  switch (ast.type) {
    case "num":
      return minorToDecimalString(ast.value);
    case "var":
      return ast.name;
    case "unary":
      return `-${astToCanonical(ast.arg)}`;
    case "op":
      return `${canonicalChild(ast.left)} ${ast.op} ${canonicalChild(ast.right)}`;
    case "call":
      return `${ast.fn}(${ast.args.map(astToCanonical).join(", ")})`;
    case "assignment":
      return `${ast.target} = ${astToCanonical(ast.expression)}`;
  }
}

function canonicalChild(node: FormulaAst): string {
  return node.type === "op" ? `(${astToCanonical(node)})` : astToCanonical(node);
}

/** Format a formula expression into readable, indented multi-line representation (spec §81). */
export function formatFormulaExpression(ast: FormulaAst): string {
  if (ast.type === "assignment") {
    return `${ast.target} =\n  ${formatNode(ast.expression, 1)}`;
  }
  return formatNode(ast, 0);
}

function formatNode(node: FormulaAst, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (node.type) {
    case "num":
      return minorToDecimalString(node.value);
    case "var":
      return node.name;
    case "unary":
      return `-${formatNode(node.arg, indent)}`;
    case "op": {
      if (node.op === "+" || node.op === "-") {
        return `(\n${pad}  ${formatNode(node.left, indent + 1)}\n${pad}  ${node.op} ${formatNode(node.right, indent + 1)}\n${pad})`;
      }
      return `${canonicalChild(node.left)} ${node.op} ${canonicalChild(node.right)}`;
    }
    case "call":
      return `${node.fn}(${node.args.map((a) => formatNode(a, indent)).join(", ")})`;
    case "assignment":
      return `${node.target} = ${formatNode(node.expression, indent)}`;
  }
}
