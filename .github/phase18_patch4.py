from pathlib import Path

original = Path('.github/phase18_patch2.py').read_text()
source = original.replace(
    "'''      </KpiGrid>\n      </StaggerItem>\n\n      {/* ONE section card''',",
    "'''      />\n      </StaggerItem>\n\n      {/* ONE section card''',",
)
source = source.replace(
    "'''      </KpiGrid>\n      </StaggerItem>\n\n      {hasGeneratedBills && (",
    "'''      />\n      </StaggerItem>\n\n      {hasGeneratedBills && (",
)
if source == original:
    raise SystemExit('Phase 18 KPI-grid transform correction did not apply')
exec(compile(source, '.github/phase18_patch4.py', 'exec'))
