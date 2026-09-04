from pathlib import Path

path = Path("src/lib/domain/ledger.ts")
text = path.read_text()
old = '''    if (journal.refId !== refund.id) {\n      // Pre-Phase-10 rows used paymentId (or null) as REFUND refId. Preserve\n      // historical validity but surface the weaker provenance explicitly.\n      refundLegacyReferenceWarnings += 1;\n    }'''
new = '''    if (journal.refId !== refund.id) {\n      // Pre-Phase-10 rows used paymentId (or null) as REFUND refId. Only those\n      // exact legacy shapes are warnings; an unrelated reference is corruption.\n      if (journal.refId == null || (refund.paymentId != null && journal.refId === refund.paymentId)) {\n        refundLegacyReferenceWarnings += 1;\n      } else {\n        refundJournalLinkMismatches += 1;\n      }\n    }'''
if old not in text:
    raise SystemExit("refund provenance anchor missing")
path.write_text(text.replace(old, new, 1))
