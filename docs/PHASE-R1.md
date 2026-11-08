# Phase R1 report: reading basics (2026-11-06)

The first part of `../../READER-PLAN.md`: what you need from an everyday PDF reader. Everything is in the
**Read** view, offline, and none of it changes the file.

## What it does

| Feature | Where | Notes |
|---|---|---|
| **Select and copy text** | Drag over text on any page, then ⌘C / Ctrl+C | pdf.js text layer, lined up with the printed text (checked to within a point, including on rotated pages and with crops). Works on scans after OCR |
| **Clickable links** | Links inside the PDF | Links to other pages jump there (to the heading if the link says where). Web and e-mail links show "Open this link?" with the address first, then open in the browser. Only http, https and mailto are allowed (checked again in Rust, `is_safe_link`, with a test) |
| **Find while reading** | Magnifier button, ⌘F / Ctrl+F | Finds across all pages with a "3 of 150" count, highlights every match, Enter / Shift+Enter or ⌘G / F3 for next and previous, Esc to close. Ignores case and extra spaces. Selected text is searched straight away |
| **Bookmarks** | "Pages / Bookmarks" switch above the thumbnails, or the bookmark button | The PDF's outline as a tree; click to jump. A PDF combined from several files lists each file's bookmarks |
| **Back and forward** | Arrow buttons, ⌘[ ⌘] / Alt+← → | After following a link or bookmark |
| **View options** | Eye button (View menu on the Mac) | Fit width (⌘0), fit page (⌘9), two pages side by side, rotate view left/right (only what's shown), night reading (pages light on dark), presentation, full screen |
| **Presentation** | View options, F5, ⌘⇧P | Full screen, one page at a time, arrows / space / click to move, Esc to finish (returns to the page you reached) |
| **Full screen** | View options, F11, ⌃⌘F | |
| **Reopen last session** | Settings > Reading (on by default) | Reopens the files that were open, at the same page, with the same tab in front. Skips files that are gone and password-protected files (so nothing asks for a password at start-up) |
| **Mac View menu** | Menu bar | Find, Find Next/Previous, Zoom, Fit, Two pages, Rotate view, Night reading, Bookmarks, Back, Forward, Presentation, Full Screen |

## How it's built

- New `app/ui/reader.js` (createReader). `app.js` only hooks it in: toolbar items, the side-panel switch, the find
  bar, the layout options in `layoutPages`, keys and the menu.
- Text and links are added after each page picture is drawn (only pages in view, as before). The find highlights use
  pdf.js text positions with character widths measured in the PDF's font, so they sit on the word.
- Rust: `open_link` (web and e-mail links only), `set_fullscreen`, and the Mac View menu. 7 Rust tests pass.
- No new libraries. The download size is unchanged.

## Checked (browser harness with the real worker)

A 6-page test PDF with bookmarks, an internal link, a web link and a rotated page:

- Text positions match the printed text. Selecting gives the right text. On the rotated page the text layer turns with the page.
- Find: 150 of 150 matches, highlight exactly over the word, next/previous moves.
- Internal link goes to page 4, Back returns to page 1, Forward is offered. Bookmark "Chapter 6" goes to page 6.
  The web link shows the confirmation with the address.
- Two pages side by side, rotate view, night reading, fit page and presentation (arrow, Esc) all work. Mark up and
  Organise are unchanged and don't get a text layer.
- Reopening: two files reopened, the missing one skipped, the right tab in front at the saved page.
- The built app starts with the new menu.

**Not checked by eye in the real app** (screen access to it was declined): the Mac menu bar's appearance,
⌘C copying from the real window, and full screen.

## Not in R1

Printing, document properties, attachments and layers (R2); the signature panel (R3); becoming the default PDF app (R4).
The installers on the website are still 0.1.0, without R1. They get rebuilt when Neel decides to release.
