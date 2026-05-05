---
name: pdf-reader
description: Extract and read text content from PDF files using pdftotext (poppler). Use when user wants to read, search, or analyze a PDF document. Triggers: "读论文", "PDF", "pdf", "read this paper", "看这篇论文".
---

## Reading PDFs

Use the `pdftotext` command to extract text from PDF files. The tool is installed via Homebrew (poppler) at `/opt/homebrew/bin/pdftotext`.

## Workflow

1. **Check file exists** — verify the PDF file path.
2. **Extract text** — run `pdftotext -layout "<file.pdf>" -` to output text to stdout.
3. **Large file handling** — if output exceeds 500 lines, save to a temp file first, then use Grep or Read to navigate. Use `pdftotext -layout "<file.pdf>" /tmp/pdf_output.txt` and read from there.
4. **Analyze** — read the extracted text and answer user questions.

## Key options

| Option | Purpose |
|--------|---------|
| `-layout` | Preserve original physical layout (best for papers) |
| `-raw` | Keep strings in content stream order |
| `-f N` | Start extraction from page N |
| `-l N` | End extraction at page N |
| `-` | Output to stdout |

## Common patterns

```bash
# Full text extraction to stdout
pdftotext -layout "paper.pdf" -

# Extract specific pages
pdftotext -layout -f 1 -l 3 "paper.pdf" -

# Save to file for large PDFs
pdftotext -layout "paper.pdf" /tmp/pdf_output.txt
```

## Notes

- `pdftotext` only extracts text content; it cannot read images, charts, or figures.
- For scanned PDFs (image-based), OCR would be needed (not covered by this skill).
- The tool handles most academic PDFs well, including multi-column layouts with `-layout`.
