"""Kafka-free checks for lifecycle ownership and persistent-data safety."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('kafka', Path(__file__).with_name('kafka.py'))
kafka = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kafka)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state_patch = patch.object(kafka, 'STATE', Path(self.directory.name))
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        with contextlib.redirect_stdout(io.StringIO()):
            kafka.initialize('test', 19092)
        self.state = kafka.read_state('test')

    def command(self, *args):
        with patch('sys.argv', ['kafka.py', *args]), contextlib.redirect_stdout(io.StringIO()):
            kafka.cli()

    def test_init_and_env_do_not_contact_docker(self):
        with patch.object(kafka.subprocess, 'run', side_effect=AssertionError('Docker contacted')):
            self.command('env', '--run', 'test')
            self.command('init', '--run', 'other', '--port', '19093')
            with self.assertRaises(FileExistsError):
                self.command('init', '--run', 'test')
        self.assertEqual(self.state, kafka.read_state('test'))

    def test_shutdown_preserves_data(self):
        with patch.object(kafka, 'assert_owned') as check, patch.object(kafka, 'compose') as compose:
            self.command('down', '--run', 'test')
        check.assert_called_once_with(self.state)
        compose.assert_called_once_with(self.state, 'down', '--timeout', '45')
        self.assertEqual(self.state, kafka.read_state('test'))

    def test_reset_requires_exact_confirmation_before_docker(self):
        with patch.object(kafka.subprocess, 'run', side_effect=AssertionError('Docker contacted')):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.command('reset', '--run', 'test', '--confirm-run', 'another')
        self.assertEqual(self.state, kafka.read_state('test'))

    def test_foreign_named_volume_is_refused(self):
        def inspect(command, **kwargs):
            # Only a foreign named volume exists; it has no Compose labels.
            return subprocess.CompletedProcess(command, 0 if command[3] == 'volume' else 1, '', '')
        def capture(command):
            return '{}' if 'inspect' in command else ''
        with patch.object(kafka.subprocess, 'run', side_effect=inspect), patch.object(kafka, 'capture', side_effect=capture):
            with self.assertRaisesRegex(RuntimeError, 'Refusing foreign volume'):
                kafka.assert_owned(self.state)

    def test_reset_does_not_forget_state_if_down_fails(self):
        with patch.object(kafka, 'assert_owned'), patch.object(kafka, 'compose', side_effect=RuntimeError('engine down')):
            with self.assertRaisesRegex(RuntimeError, 'engine down'):
                self.command('reset', '--run', 'test', '--confirm-run', 'test')
        self.assertEqual(self.state, kafka.read_state('test'))

    def test_run_state_cannot_select_another_project(self):
        state = {**self.state, 'project': 'unrelated-project'}
        kafka.state_path('test').write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, 'Unexpected project name'):
            kafka.read_state('test')


if __name__ == '__main__':
    unittest.main()
