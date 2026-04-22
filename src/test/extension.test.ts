import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('openMdInBrowser', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'open-md-in-browser');
    await ext?.activate();
  });

  test('command is registered', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('openMdInBrowser.open'));
  });

  test('renders a Markdown document without throwing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omib-test-'));
    const tmpFile = path.join(tmpDir, 'sample.md');
    fs.writeFileSync(tmpFile, '# Hello\n\nWorld\n', 'utf8');
    const uri = vscode.Uri.file(tmpFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('openMdInBrowser.open', uri);
  });
});

