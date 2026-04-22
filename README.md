# Open Markdown in Browser

Render the active or selected Markdown file as a complete HTML document and open it in your default web browser.

## Features

* Single command, `Markdown: Open in Browser`, available from five entry points:
  * Editor title bar globe icon
  * Editor context menu (right-click in a `.md` file)
  * Explorer context menu (right-click an `.md` or `.markdown` file)
  * Command palette
  * Keyboard shortcut: `Ctrl+Shift+Alt+V` (Windows/Linux) or `Cmd+Shift+Alt+V` (macOS)
* Renders Markdown with [`markdown-it`](https://github.com/markdown-it/markdown-it) using safe defaults (raw HTML disabled).
* Styles output with [github-markdown-css](https://github.com/sindresorhus/github-markdown-css).
* Resolves relative image and link URLs against the source file's directory.
* Opens the rendered HTML in the system default browser via `vscode.env.openExternal`.

## Usage

1. Open a Markdown file in VS Code.
2. Click the globe icon in the editor title bar, or use any other entry point listed above.
3. The rendered HTML opens in your default web browser.

Dirty buffers are saved automatically before rendering.

## Settings

This extension does not contribute settings yet.

## Known Limitations

* Some browsers restrict cross-directory loads from `file://` URLs. Images outside the Markdown file's directory may not load when the rendered HTML lives in extension storage.
* The extension does not run in virtual workspaces because it depends on Node `fs` to read the source file.
* In untrusted workspaces, the extension still renders Markdown but raw HTML in the source remains disabled.

## Requirements

* VS Code 1.85.0 or later (runtime)
* Node.js 20 or later (development workflows: `npm install`, `npm run lint`, `npm test`, `npm run package`)

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

This is a personal, independent project and is not affiliated with or endorsed by Microsoft.  
All code and opinions are my own.

