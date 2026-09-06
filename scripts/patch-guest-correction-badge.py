from pathlib import Path
p = Path('src/app/api/v1/admin/meals/route.ts')
s = p.read_text()
old = '''          const match = g.note?.match(/Admin override\\|orig:(\\d+)/);'''
new = '''          const match = g.note?.match(/(?:Admin override|Admin post-service correction)\\|orig:(\\d+)/);'''
if s.count(old) != 1:
    raise SystemExit(f'expected one regex match, got {s.count(old)}')
s = s.replace(old, new, 1)
old2 = '''          if (g.note === "Admin override" || g.note?.startsWith("Admin override")) {'''
new2 = '''          if (\n            g.note === "Admin override" ||\n            g.note?.startsWith("Admin override") ||\n            g.note?.startsWith("Admin post-service correction")\n          ) {'''
if s.count(old2) != 1:
    raise SystemExit(f'expected one fallback match, got {s.count(old2)}')
s = s.replace(old2, new2, 1)
p.write_text(s)
print('patched correction badge parser')
