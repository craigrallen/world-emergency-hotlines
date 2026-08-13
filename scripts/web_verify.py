#!/usr/bin/env python3
"""Deprecated compatibility entry point for the read-only source monitor."""
import sys
from source_monitor import main

if __name__ == "__main__":
    legacy = [flag for flag in ("--status", "--force", "--start") if flag in sys.argv[1:]]
    if legacy:
        print(
            "MIGRATION REQUIRED: legacy mutation flags " + ", ".join(legacy) +
            " are disabled. Run: python scripts/source_monitor.py --as-of YYYY-MM-DD "
            "--json-output source-snapshot.json --markdown-output source-report.md",
            file=sys.stderr,
        )
        raise SystemExit(2)
    print("DEPRECATED: web_verify.py is read-only. Use scripts/source_monitor.py; canonical promotion requires the separate candidate/approval workflow.", file=sys.stderr)
    raise SystemExit(main())
