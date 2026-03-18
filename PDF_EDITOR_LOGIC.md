# PDF Editor Logic — How It Works

## Overview

The PDF editor is entirely client-side. No server is involved at any point. It uses two libraries loaded from CDN:

- **PDF.js** (`pdf.min.js`) — reads and renders PDF pages
- **pdf-lib** (`pdf-lib.min.js`) — writes and modifies PDF binary data

The flow has three distinct phases: **view**, **edit**, and **save**.

---

## Phase 1 — View Mode (Default)

When a PDF is dropped into the editor, this happens in `editorLoadFile`:

```js
blobUrl = URL.createObjectURL(file);
viewMode = 'pdf';
```

`URL.createObjectURL(file)` creates a temporary in-memory URL pointing to the raw PDF bytes held by the browser. This URL (`blob:http://localhost:3000/...`) is set as the `src` of an `<iframe>`, which makes the browser's built-in PDF viewer render the file. This is cheap and fast — no parsing, no libraries needed.

The `file` object itself is stored on the doc entry:

```js
editorDocs.push({ name, text, viewMode, blobUrl, htmlContent, file });
```

The `file` reference is critical — it is reused later during edit mode to get the raw PDF bytes.

---

## Phase 2 — Edit Mode (`startPdfEditMode`)

Triggered when the user clicks **"✏️ Edit Live"**.

### Step 1: Configure PDF.js worker

```js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/.../pdf.worker.min.js';
```

PDF.js offloads all PDF parsing to a Web Worker so the UI thread doesn't freeze. The worker URL must be set before any document is loaded.

### Step 2: Parse the PDF

```js
const arrayBuf = await doc.file.arrayBuffer();
const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) }).promise;
```

`doc.file.arrayBuffer()` reads the raw bytes of the original PDF file the user dropped. These bytes are handed to PDF.js, which parses the PDF's internal structure — pages, fonts, content streams, and text positions.

### Step 3: For each page — render canvas + build text layer

The iframe is hidden. For every page, two layers are created and stacked inside a `.pdf-edit-page` div:

```
┌─────────────────────────────────┐
│  .pdf-edit-page (position:rel)  │
│  ┌───────────────────────────┐  │
│  │  <canvas>   (visual)      │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  .pdf-text-layer (abs)    │  │
│  │    <span> <span> <span>   │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

**Canvas layer** — PDF.js renders the page visually at 1.5× scale:

```js
const viewport = page.getViewport({ scale: 1.5 });
await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
```

This produces a pixel-perfect image of the page. It is never modified.

**Text layer** — PDF.js also exposes the raw text content of each page via `page.getTextContent()`. Each `item` in `textContent.items` represents one run of characters with the same font/size/position, and has:

- `item.str` — the string (e.g. `"Hello"`)
- `item.transform` — a 6-element matrix `[a, b, c, d, e, f]` in PDF coordinate space, where `e` = x position (left), `f` = y position (from bottom), and `a` ≈ font size in points

### Step 4: Coordinate conversion (PDF space → screen space)

PDF uses a bottom-left origin. The browser uses top-left. The viewport transform handles this inversion:

```js
const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
```

`viewport.transform` for a 1.5× scale, unrotated page is:
```
[1.5,  0,    0,  -1.5,  0,  pageHeightPx]
```

Multiplying with `item.transform` produces `tx`:
- `tx[4]` = screen x from left (= `pdfX × 1.5`)
- `tx[5]` = screen y from top at the text **baseline** (= `pageHeightPx - pdfY × 1.5`)
- font height in pixels = `√(tx[0]² + tx[1]²)` (= `fontSize × 1.5`)

The span is positioned so its **top edge** aligns with the top of the character:

```js
span.style.left = `${tx[4]}px`;
span.style.top  = `${tx[5] - fontHeight}px`;  // baseline y minus font height
span.style.fontSize = `${fontHeight}px`;
```

The PDF coordinates (points, from bottom) are stored as `data-*` attributes for later use during save:

```js
span.dataset.pdfX      = item.transform[4];  // x in PDF points
span.dataset.pdfY      = item.transform[5];  // y in PDF points (from bottom)
span.dataset.pdfFs     = Math.abs(item.transform[0]);  // font size in points
span.dataset.pdfWidth  = item.width;         // text width in PDF points
span.dataset.pdfHeight = Math.abs(item.transform[3] || item.transform[0]);
```

### Step 5: Making the span editable and invisible

```js
span.contentEditable = 'true';
```

By default the span is `color: transparent`. This is key — the canvas is showing the real text, and the span sits exactly on top of it but is invisible. The user sees the canvas rendering, not the span text.

When the user **focuses** a span:
```css
.pdf-text-item:focus {
  color: #111;
  background: rgba(255,255,255,0.97);
}
```
The span goes opaque white, hiding the canvas text behind it and showing the span's editable text. The user is now editing the span's text content, not the canvas.

When text is changed, an `input` listener marks the span:
```js
span.addEventListener('input', () => {
  span.dataset.changed = span.textContent !== span.dataset.original ? 'true' : '';
});
```

Changed spans turn yellow via CSS, giving the user a visual diff of all their edits.

---

## Phase 3 — Save (`savePdfEdits`)

Triggered when the user clicks **"💾 Save PDF"**.

### Step 1: Collect only changed spans

```js
const changedSpans = [
  ...pdfEditContainer.querySelectorAll('.pdf-text-item[data-changed="true"]')
];
```

Only spans where `data-changed="true"` are processed. Untouched text is left alone in the original PDF binary — nothing is rewritten unnecessarily.

### Step 2: Load the original PDF into pdf-lib

```js
const { PDFDocument, rgb, StandardFonts } = PDFLib;
const arrayBuf = await doc.file.arrayBuffer();
const pdfDoc = await PDFDocument.load(arrayBuf, { ignoreEncryption: true });
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
```

`doc.file` is the same original `File` object stored during load. pdf-lib reads the raw bytes and parses the full PDF object graph (pages, resources, content streams). `embedFont(StandardFonts.Helvetica)` adds the Helvetica font definition to the PDF's resource dictionary so it can be used for new text.

### Step 3: For each changed span — white out and redraw

This is the "annotation overlay" technique used by most PDF editors:

**White out the original text:**
```js
page.drawRectangle({
  x: x - 1, y: y - h * 0.15,
  width: w + 2, height: h * 1.3,
  color: rgb(1, 1, 1),
  borderWidth: 0,
});
```

pdf-lib draws a solid white rectangle over exactly where the original text sits (in PDF point coordinates, which are already stored in `data-pdfX`, `data-pdfY` etc.). This is added as a new annotation on top of the existing content stream — the original text bytes are not deleted from the PDF.

**Draw the new text:**
```js
page.drawText(newText, { x, y, size: fs, font, color: rgb(0, 0, 0) });
```

New text is drawn at the same `x, y` position (bottom-left of the character baseline), same font size in points, in black. If the user deleted the text entirely (empty span), this step is skipped — only the white rectangle remains, effectively erasing the original.

### Step 4: Serialize and download

```js
const bytes = await pdfDoc.save();
const blob = new Blob([bytes], { type: 'application/pdf' });
const newUrl = URL.createObjectURL(blob);
```

pdf-lib serializes the entire modified PDF back to a `Uint8Array`. A new blob URL is created from these bytes and triggered as a download with `_edited.pdf` appended to the filename.

### Step 5: Update doc state for re-editing

```js
doc.blobUrl = newUrl;
doc.file = new File([bytes], doc.name, { type: 'application/pdf' });
```

The doc entry is updated to point to the new modified PDF bytes. If the user clicks "Edit Live" again, they will be editing the already-edited version, not the original.

---

## Coordinate System Summary

| Coordinate space | Origin | Y direction | Unit |
|---|---|---|---|
| PDF (spec) | bottom-left | up | points (1/72 inch) |
| PDF.js viewport | top-left | down | pixels (at scale) |
| HTML/CSS | top-left | down | pixels |
| pdf-lib | bottom-left | up | points |

PDF.js handles the conversion from PDF space → screen space via `pdfjsLib.Util.transform`. The `data-pdf*` attributes store the original PDF-space values, so pdf-lib can use them directly without any reverse conversion.

---

## Known Limitations

- **Font substitution**: Replaced text always uses Helvetica regardless of the original font. If the original used a custom or serif font, the style will visually differ.
- **Text reflow**: PDF text positions are absolute — if you type more characters than the original, the text will overflow its original bounding box. PDF has no automatic line wrapping.
- **White-out approach**: The original text is not deleted from the PDF content stream — it is covered by a white rectangle. The file size grows slightly with each edit. Some advanced PDF readers or accessibility tools may still find the original text.
- **Encrypted PDFs**: `ignoreEncryption: true` is passed to pdf-lib, which bypasses read locks but cannot write to PDFs with write restrictions.
- **Rotated/skewed text**: Font height calculation (`√(tx[0]² + tx[1]²)`) works for normal text but is approximate for rotated glyphs.
