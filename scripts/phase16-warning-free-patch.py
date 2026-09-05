from pathlib import Path


def replace_once(path: str, old: str, new: str) -> bool:
    p = Path(path)
    text = p.read_text()
    if new in text and old not in text:
        return False
    if old not in text:
        raise SystemExit(f"expected pattern missing in {path}")
    p.write_text(text.replace(old, new, 1))
    return True

changed = False
changed = replace_once(
    "src/components/app/admin/tasks.tsx",
    'import { useMemo, useState } from "react";',
    'import { useState } from "react";',
) or changed

old_block = '''  const sortedTasks = useMemo(() => {\n    return [...tasks].sort((a, b) => {\n      const getRank = (st: string) => {\n        if (st === "SUBMITTED") return 0; // Needs admin review\n        if (st === "IN_PROGRESS" || st === "ACCEPTED" || st === "ASSIGNED") return 1; // Active\n        return 2; // Completed / Rejected\n      };\n      const rA = getRank(a.status);\n      const rB = getRank(b.status);\n      if (rA !== rB) return rA - rB;\n\n      if (rA === 1) {\n        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);\n        if (a.dueDate) return -1;\n        if (b.dueDate) return 1;\n      }\n\n      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();\n    });\n  }, [tasks]);'''

new_block = '''  // Sorting a copied query result is cheap at this list size and avoids manual\n  // memoization that React Compiler cannot safely preserve for this dependency.\n  const sortedTasks = [...tasks].sort((a, b) => {\n    const getRank = (st: string) => {\n      if (st === "SUBMITTED") return 0; // Needs admin review\n      if (st === "IN_PROGRESS" || st === "ACCEPTED" || st === "ASSIGNED") return 1; // Active\n      return 2; // Completed / Rejected\n    };\n    const rA = getRank(a.status);\n    const rB = getRank(b.status);\n    if (rA !== rB) return rA - rB;\n\n    if (rA === 1) {\n      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);\n      if (a.dueDate) return -1;\n      if (b.dueDate) return 1;\n    }\n\n    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();\n  });'''
changed = replace_once("src/components/app/admin/tasks.tsx", old_block, new_block) or changed
changed = replace_once(
    "package.json",
    '"lint": "eslint .",',
    '"lint": "eslint . --max-warnings=0",',
) or changed

print("Phase 16 warning-free patch applied" if changed else "Phase 16 patch already applied")
