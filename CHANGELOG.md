# Changelog

All notable changes to the `open-md-in-browser` extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.6.0 - 2026-05-14

### Added

* TOC sidebar with scroll spy for documents with 4+ headings (visible at ≥1544 px).
* Collapsible sections that wrap h2 content in `<details>`/`<summary>` with Collapse/Expand All controls.
* Heading quick-jump modal (Ctrl+K) with filtered search, arrow-key navigation, and level badges.
* Reading-time estimate and progress bar with back-to-top button.
* `aria-activedescendant` support in heading-search input for screen readers.

### Fixed

* Heading-search combobox now exposes proper ARIA roles (`combobox`, `listbox`, `option`) for assistive technology.
* Table-of-contents fly-out now renders to the left of the article instead of overlaying it. Restores the centered 980 px column by overriding the vendor `.markdown-body { margin: 0 }` rule with `body.markdown-body { margin: 0 auto }`. The 1543 px visibility breakpoint introduced alongside the TOC sidebar is preserved.

## 0.5.0 - 2026-05-14

### Added

* Clicking a relative link to another `.md` file in the preview now renders the target as full HTML with styles, Mermaid diagrams, and frontmatter — instead of serving raw Markdown.
* Fragment links on `.md` references (e.g. `./other.md#section`) render the target and scroll to the anchor.
* Heading IDs are generated using the GitHub-compatible slug algorithm (lowercase, hyphens, Unicode preserved, duplicate suffixes) so `#anchor` links scroll to the correct heading.
* Example files `internal-links-test.md` and `linked-doc-test.md` for testing cross-file navigation.

### Fixed

* Path containment checks are now case-insensitive on Windows, fixing "Forbidden" errors when `fs.realpath` callback and promise APIs return different drive-letter casing.

## 0.4.0 - 2026-04-28

### Changed

* Prepare extension for VS Code Marketplace publishing: add publisher, repository, and marketplace metadata fields.

## 0.3.5 - 2026-04-27

### Internal

* Maintenance release.

## 0.3.4 - 2026-04-27

### Fixed

* Mermaid diagrams render again. Mermaid v11 ships its ESM entry as a thin shim that statically and dynamically imports per-diagram chunks from `./chunks/mermaid.esm.min/*.mjs`; the preview server now serves those chunk files under `/_assets/chunks/mermaid.esm.min/<name>.mjs` (strict allow-list with `^[A-Za-z0-9_-]+\.mjs$` filename pattern and realpath containment).
* Any unrecognised `/_assets/...` request now fails closed with 404 instead of falling through to the workspace file handler.

## 0.3.3 - 2026-04-26

### Fixed

* VSIX packaging now ships `node_modules/mermaid/dist/**` so Mermaid diagrams render in the Marketplace-installed extension. Local `F5` development was unaffected; this only changes the published artifact.

### Internal

* Added `npm run verify:package` to assert that the VSIX file list contains both `media/mermaid-init.mjs` and `node_modules/mermaid/dist/mermaid.esm.min.mjs`.

## 0.3.2 - 2026-04-23

### Fixed

* Mermaid sequence diagrams no longer fail with "Syntax error in text" when labels contain `<port>` or other angle-bracketed text. Fence content is now HTML-escaped so the browser preserves it as text and mermaid reads the original source via `textContent` decoding (restores literal `<br/>` handling in flowchart labels).

## 0.3.1 - 2026-04-23

### Fixed

* Pass mermaid fenced-block content through un-escaped so inline `<br/>` inside node labels renders as line breaks; only `</pre>` is neutralized to keep the container tag intact.

## 0.3.0 - 2026-04-23

### Added

* Render ` ```mermaid ` fenced code blocks as diagrams in the preview using `mermaid` loaded from jsDelivr; theme follows the OS color scheme preference.

## 0.2.0 - 2026-04-23

### Added

* YAML frontmatter is parsed with `gray-matter` and rendered as a metadata table above the document body in the preview.
* When present, the frontmatter `title` field is used as the HTML document title.
* Exported helpers `extractFrontmatter` and `renderFrontmatterTable` with unit tests covering HTML escaping, empty data, BOM/CRLF input, and non-frontmatter thematic breaks.

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
