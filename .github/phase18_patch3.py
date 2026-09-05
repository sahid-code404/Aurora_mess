from pathlib import Path

source = Path('.github/phase18_patch2.py').read_text()
source = source.replace(
    "'''      </KpiGrid>\n      </StaggerItem>\n\n      {/* ONE section card''',",
    "'''      />\n      </StaggerItem>\n\n      {/* ONE section card''',",
)
if source == Path('.github/phase18_patch2.py').read_text():
    raise SystemExit('Phase 18 patch anchor replacement did not apply')
exec(compile(source, '.github/phase18_patch3.py', 'exec'))
