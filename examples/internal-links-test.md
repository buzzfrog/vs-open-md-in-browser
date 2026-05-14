---
title: Internal Links Test
author: Test Suite
date: 2026-05-14
tags: [links, anchors, test, preview]
---

# Internal Links Test

Open this file via **Markdown: Open in Browser** to verify internal link navigation.

## Table of Contents

* [Introduction](#introduction)
* [Features](#features)
* [Duplicate Heading Test](#duplicate-heading)
* [Another Duplicate](#duplicate-heading-1)
* [Unicode Heading Test](#café-naïve-résumé)
* [Code in Heading](#the-render-function)
* [Links to Other Files](#links-to-other-files)
* [Non-Markdown Links](#non-markdown-links)

## Introduction

This file tests anchor links within the same document. Clicking any link in the table of contents above should scroll to the corresponding heading.

Paragraph with enough content to push headings below the fold so scrolling is visible when testing anchor navigation in the browser.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

## Features

This section verifies that heading IDs are generated with the GitHub-compatible slug algorithm:

* Spaces become hyphens
* ASCII punctuation is stripped
* Text is lowercased
* Unicode characters are preserved

## Duplicate Heading

First occurrence of this heading. Its `id` should be `duplicate-heading`.

Back to [top](#internal-links-test).

## Duplicate Heading

Second occurrence. Its `id` should be `duplicate-heading-1` (deduplicated with a suffix).

## Café, Naïve & Résumé

Unicode characters in headings should be preserved in the slug. This heading tests accented Latin characters.

## The `render()` Function

Inline code in headings should contribute to the slug text.

## Links to Other Files

These links point to another Markdown file in the same directory. Clicking them should render the target as HTML in the browser (not show raw Markdown).

* [Linked Document](./linked-doc-test.md) (renders the full linked document)
* [Linked Document — Features section](./linked-doc-test.md#features) (renders and scrolls to the anchor)
* [Back-reference section in linked doc](./linked-doc-test.md#back-references) (renders and scrolls to back-references)
* [Mermaid Test](./mermaid-test.md) (existing Mermaid test file)
* [Mermaid Flowchart section](./mermaid-test.md#1-flowchart-with-br-line-breaks-in-labels) (Mermaid test with anchor)

## Non-Markdown Links

These links point to non-Markdown resources. They should be served as raw files with the correct MIME type.

* Link to a file that does not exist: [missing.txt](./missing.txt) (expect 404)
* External link: <https://github.com> (navigates away from preview)

## Path Traversal (Should Fail)

These links attempt to escape the `rootDir`. The server should block them with 403.

* [Parent directory escape](../package.json) (should be blocked)
* [Double parent escape](../../etc/passwd) (should be blocked)

## Summary

| Test Case                  | Expected Behavior                  |
|----------------------------|------------------------------------|
| `#introduction`            | Scrolls to Introduction heading    |
| `#duplicate-heading`       | Scrolls to first duplicate         |
| `#duplicate-heading-1`     | Scrolls to second duplicate        |
| `#café-naïve-résumé`       | Scrolls to Unicode heading         |
| `./linked-doc-test.md`     | Renders linked doc as HTML         |
| `./linked-doc-test.md#features` | Renders and scrolls to anchor |
| `./mermaid-test.md`        | Renders Mermaid doc as HTML        |
| `../package.json`          | Blocked (403)                      |
