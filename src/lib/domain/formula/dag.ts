/**
 * FORMULA DEPENDENCY GRAPH & CYCLE DETECTION (spec §43-45, §86-87)
 *
 * Implements a Directed Acyclic Graph (DAG) for BoardOps formulas.
 * - Extracts variable references from AST
 * - Detects direct self-reference (A = A + 1)
 * - Detects circular dependencies (A -> B -> A)
 * - Computes topological evaluation order
 * - Computes downstream impact maps
 */
import { ApiError, CODES } from "@/lib/errors";
import { extractVariableNames, FormulaAst } from "./ast";

export interface FormulaDependencyNode {
  outputVariableKey: string;
  formulaDefinitionId?: string;
  name?: string;
  ast: FormulaAst;
  dependsOn: string[];
}

export class FormulaDag {
  private nodes = new Map<string, FormulaDependencyNode>();

  addNode(node: FormulaDependencyNode) {
    this.nodes.set(node.outputVariableKey, node);
  }

  /**
   * Check if setting candidateAst for targetVariableKey would create a cycle.
   * Throws FORMULA_INVALID ApiError if a cycle is detected.
   */
  validateNoCycles(targetVariableKey: string, candidateAst: FormulaAst): void {
    const directDependencies = extractVariableNames(candidateAst);

    // Direct self-reference check (spec §45)
    if (directDependencies.includes(targetVariableKey)) {
      throw new ApiError(
        CODES.FORMULA_INVALID,
        `Cannot save formula: '${targetVariableKey}' cannot depend directly on itself.`,
        422
      );
    }

    // Clone graph and test candidate insertion
    const tempGraph = new Map<string, string[]>();
    for (const [key, node] of this.nodes.entries()) {
      if (key !== targetVariableKey) {
        tempGraph.set(key, [...node.dependsOn]);
      }
    }
    tempGraph.set(targetVariableKey, directDependencies);

    // Depth-first search for cycle
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const hasCycle = (curr: string): boolean => {
      visited.add(curr);
      recStack.add(curr);
      path.push(curr);

      const neighbors = tempGraph.get(curr) ?? [];
      for (const next of neighbors) {
        if (!visited.has(next)) {
          if (hasCycle(next)) return true;
        } else if (recStack.has(next)) {
          path.push(next);
          return true;
        }
      }

      recStack.delete(curr);
      path.pop();
      return false;
    };

    if (hasCycle(targetVariableKey)) {
      const cycleDescription = path.join(" → ");
      throw new ApiError(
        CODES.FORMULA_INVALID,
        `Cannot save this formula because it creates a circular dependency: ${cycleDescription}.`,
        422
      );
    }
  }

  /**
   * Return derived variable keys in topological evaluation order.
   * If A depends on B, B appears BEFORE A.
   */
  getTopologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const key of this.nodes.keys()) {
      inDegree.set(key, 0);
      adj.set(key, []);
    }

    for (const [key, node] of this.nodes.entries()) {
      for (const dep of node.dependsOn) {
        if (this.nodes.has(dep)) {
          // Edge from dep to key: dep must be computed before key
          adj.get(dep)!.push(key);
          inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [key, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(key);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      order.push(u);

      for (const v of adj.get(u) ?? []) {
        inDegree.set(v, inDegree.get(v)! - 1);
        if (inDegree.get(v) === 0) {
          queue.push(v);
        }
      }
    }

    if (order.length !== this.nodes.size) {
      throw new ApiError(
        CODES.FORMULA_INVALID,
        "Circular dependency detected among saved formulas.",
        422
      );
    }

    return order;
  }

  /**
   * Find all downstream formulas affected when `variableKey` changes (spec §131-132).
   */
  getDownstreamImpact(variableKey: string): string[] {
    const affected = new Set<string>();
    const queue = [variableKey];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const [key, node] of this.nodes.entries()) {
        if (node.dependsOn.includes(curr) && !affected.has(key)) {
          affected.add(key);
          queue.push(key);
        }
      }
    }

    return Array.from(affected);
  }
}
