"use client";

import AdminFormulas from "./formulas";
import FormulaKpiControls from "./formula-kpis";

/**
 * One Admin destination for calculations: existing Variables + Formulas first,
 * then the deliberately simple KPI mapping controls. Keeping the mature Formula
 * Engine intact avoids duplicating its versioning, preview and audit workflows.
 */
export default function AdminFormulasUnified() {
  return (
    <div className="space-y-4">
      <AdminFormulas />
      <FormulaKpiControls />
    </div>
  );
}
