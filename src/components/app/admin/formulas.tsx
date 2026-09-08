"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { GlassButton } from "@/components/glass/GlassButton";
import FormulaKpiCenter from "./formula-kpi-center";
import FormulaWorkbench from "./formula-workbench";

/**
 * Simple Admin entry point for calculations.
 *
 * The KPI Control Center is intentionally the default view: it tells an Admin
 * what a number means, where it comes from and whether it is safe to edit.
 * The proven full Formula/Variable workbench remains available on demand for
 * creating variables, creating formulas, history and advanced inspection.
 */
export default function AdminFormulas() {
  const [showWorkbench, setShowWorkbench] = useState(false);

  return (
    <div className="space-y-5">
      <FormulaKpiCenter onOpenWorkbench={() => setShowWorkbench(true)} />

      <div id="formula-workbench" className="space-y-3">
        <div className="flex items-center justify-center">
          <GlassButton
            variant="secondary"
            icon={<Settings2 />}
            onClick={() => setShowWorkbench((open) => !open)}
          >
            {showWorkbench ? "Hide formulas & variables" : "Open formulas & variables"}
            {showWorkbench ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </GlassButton>
        </div>

        {showWorkbench && <FormulaWorkbench />}
      </div>
    </div>
  );
}
