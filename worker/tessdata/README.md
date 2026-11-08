# OCR language data

Tesseract LSTM models from **tessdata_fast** (https://github.com/tesseract-ocr/tessdata_fast, branch
`main`), downloaded 2026-11-05. Licence: **Apache-2.0** (the repository states that all data in it is
licensed under Apache-2.0). Used by MuPDF's built-in Tesseract OCR (through PyMuPDF), so no separate
Tesseract program is needed.

| File | Language | SHA-256 |
|---|---|---|
| eng.traineddata | English | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |
| asm.traineddata | Assamese | `299c7f6135ac72ca4820d4c39e3cf65b32b24127fc78c4938d11153adbb9fa77` |
| ben.traineddata | Bengali | `31163084c279aaebd376216f0c3d5c17ad4b5fee8db49dae79c20000b5de5964` |
| hin.traineddata | Hindi | `4c73ffc59d497c186b19d1e90f5d721d678ea6b2e277b719bee4e2af12271825` |

To add a language, put its `.traineddata` from the same repository here, add it to this table and
to `LANGUAGES` in `src/aw_pdf_worker/ocr.py`.
