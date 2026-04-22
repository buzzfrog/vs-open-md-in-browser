# Changelog

All notable changes to the `open-md-in-browser` extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.1 - 2026-04-18

### Added

* `PreviewServer` that serves rendered Markdown over a local HTTP endpoint, enabling preview in the default browser from WSL and remote development environments.
* Unit tests for `PreviewServer`.

### Fixed

* Removed the `icon` field that referenced a missing `images/icon.png`, unblocking `vsce` packaging.

## 0.1.0 - 2026-04-17

### Added

* Initial release.
* Command `openMdInBrowser.open` (`Markdown: Open in Browser`) renders the active or selected Markdown file as HTML and opens it in the default browser.
* Five entry points: editor title bar, editor context menu, explorer context menu, command palette, and `Ctrl+Shift+Alt+V` / `Cmd+Shift+Alt+V` keybinding.
* Safe rendering with `markdown-it` (raw HTML disabled).
* GitHub-style output via inlined `github-markdown-css`.
* Relative URL absolutization for images and links.
