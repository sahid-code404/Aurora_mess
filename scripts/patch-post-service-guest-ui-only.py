from pathlib import Path

path = Path('src/components/app/admin/meals.tsx')
s = path.read_text()

def replace_once(old: str, new: str):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, got {count}: {old[:120]!r}')
    s = s.replace(old, new, 1)

replace_once(
'''    cutoffAt: string;\n    status: "OPEN" | "LOCKED" | string;''',
'''    cutoffAt: string;\n    lockAt: string;\n    status: "OPEN" | "LOCKED" | string;'''
)

replace_once(
'''  currentQuantity: number;\n  targetQuantity: number;\n}''',
'''  currentQuantity: number;\n  targetQuantity: number;\n  serviceEnded: boolean;\n}'''
)

replace_once(
'''                              const cutoffPassed = instance\n                                ? new Date(instance.instance.cutoffAt).getTime() <= Date.now() || instance.instance.status !== "OPEN"\n                                : false;''',
'''                              const cutoffPassed = instance\n                                ? new Date(instance.instance.lockAt).getTime() <= Date.now() || instance.instance.status !== "OPEN"\n                                : false;\n                              const serviceEnded = instance\n                                ? new Date(instance.instance.serviceWindow.endAt).getTime() <= Date.now()\n                                : false;'''
)

replace_once(
'''                                                targetQuantity: mealGuestCount - 1,\n                                              });''',
'''                                                targetQuantity: mealGuestCount - 1,\n                                                serviceEnded,\n                                              });'''
)
replace_once(
'''                                                targetQuantity: mealGuestCount + 1,\n                                              });''',
'''                                                targetQuantity: mealGuestCount + 1,\n                                                serviceEnded,\n                                              });'''
)
replace_once(
'''                                              targetQuantity: 1,\n                                            });''',
'''                                              targetQuantity: 1,\n                                              serviceEnded,\n                                            });'''
)

replace_once(
'''          title={`${guestOverride.targetQuantity > guestOverride.currentQuantity ? "Add guest meal" : "Remove guest meal"} — ${guestOverride.meal.name}`}''',
'''          title={`${guestOverride.serviceEnded ? "Correct guest meal" : guestOverride.targetQuantity > guestOverride.currentQuantity ? "Add guest meal" : "Remove guest meal"} — ${guestOverride.meal.name}`}'''
)

replace_once(
'''              {guestOverride.meal.locked\n                ? "This meal is already locked for residents. Your admin override applies after the cutoff and is recorded in the audit trail with your reason."\n                : "The resident's guest meal count is modified by your decision. Residents are notified and the change is audited."}''',
'''              {guestOverride.serviceEnded\n                ? "This service has ended. You are making an audited post-service correction. The corrected guest quantity will update meal counts, guest income, Formula Engine variables and future billing while this billing month is still open. Once billing is in progress or finalized, this source correction is locked and bill/refund correction must be used instead."\n                : guestOverride.meal.locked\n                  ? "This meal is already locked for residents. Your admin override applies after the lock boundary and is recorded in the audit trail with your reason."\n                  : "The resident's guest meal count is modified by your decision. Residents are notified and the change is audited."}'''
)

replace_once(
'''          confirmLabel={guestOverride.targetQuantity === 0 ? "Remove guests" : `Set to ${guestOverride.targetQuantity} guest${guestOverride.targetQuantity === 1 ? "" : "s"}`}''',
'''          confirmLabel={\n            guestOverride.serviceEnded\n              ? guestOverride.targetQuantity === 0\n                ? "Correct to 0 guests"\n                : `Correct to ${guestOverride.targetQuantity} guest${guestOverride.targetQuantity === 1 ? "" : "s"}`\n              : guestOverride.targetQuantity === 0\n                ? "Remove guests"\n                : `Set to ${guestOverride.targetQuantity} guest${guestOverride.targetQuantity === 1 ? "" : "s"}`\n          }'''
)

path.write_text(s)
print('patched', path)
