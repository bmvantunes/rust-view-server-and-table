#!/usr/bin/env python3
"""Select both Cargo and its compiler explicitly; Homebrew tools may lead PATH."""
import os
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.99.0'
def selected(tool):
    return subprocess.check_output(['rustup', 'which', '--toolchain', VERSION, tool], text=True).strip()
def main():
    cargo = selected('cargo')
    env = {**os.environ, 'RUSTC': selected('rustc'), 'RUSTDOC': selected('rustdoc'),
           'PATH': str(Path(cargo).parent) + os.pathsep + os.environ.get('PATH', '')}
    # Cargo subcommands (notably cargo-clippy and clippy-driver) must resolve
    # from this same toolchain; RUSTC alone does not select those executables.
    return subprocess.call(['rustup', 'run', VERSION, cargo, *sys.argv[1:]], cwd=ROOT, env=env)
if __name__ == '__main__':
    sys.exit(main())
