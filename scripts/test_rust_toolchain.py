"""Kafka-free regression for Cargo subcommands shadowed by host installations."""
import os
import unittest
from unittest.mock import patch
import rust

class ToolchainTests(unittest.TestCase):
    def test_cargo_and_subcommands_share_explicit_toolchain(self):
        with patch.object(rust, 'selected', side_effect=lambda name: '/selected/toolchain/bin/' + name), patch.object(rust.subprocess, 'call', return_value=0) as invoke, patch.dict(os.environ, {'PATH': '/old/homebrew/bin:/usr/bin'}), patch.object(rust.sys, 'argv', ['rust.py', 'clippy', '--version']):
            self.assertEqual(rust.main(), 0)
        args, kwargs = invoke.call_args
        self.assertEqual(args[0], ['rustup', 'run', rust.VERSION, '/selected/toolchain/bin/cargo', 'clippy', '--version'])
        self.assertEqual(kwargs['env']['PATH'].split(os.pathsep)[0], '/selected/toolchain/bin')
        self.assertEqual(kwargs['env']['RUSTC'], '/selected/toolchain/bin/rustc')
        self.assertEqual(kwargs['env']['RUSTDOC'], '/selected/toolchain/bin/rustdoc')
