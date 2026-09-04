"""Browser resolver checks; no browser process or downloads are required."""

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from browser_launch import chromium_launch_options


class BrowserLaunchTests(unittest.TestCase):
    def test_explicit_executable_takes_precedence(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": str(Path(__file__).resolve())}):
            self.assertEqual(chromium_launch_options(), {"executable_path": str(Path(__file__).resolve())})

    def test_missing_explicit_executable_fails(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "missing-browser.exe"}):
            with patch.object(Path, "is_file", return_value=False):
                with self.assertRaises(FileNotFoundError):
                    chromium_launch_options()

    def test_no_system_browser_uses_playwright_default(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": ""}):
            with patch.object(Path, "is_file", return_value=False):
                self.assertEqual(chromium_launch_options(), {})

    @unittest.skipUnless(os.name == "nt", "Windows installation paths")
    def test_system_chrome_is_selected(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": ""}):
            with patch.object(Path, "is_file", return_value=True):
                self.assertTrue(chromium_launch_options()["executable_path"].endswith("chrome.exe"))


if __name__ == "__main__":
    unittest.main()
