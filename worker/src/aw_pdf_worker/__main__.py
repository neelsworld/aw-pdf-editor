# SPDX-License-Identifier: AGPL-3.0-or-later
"""Worker entry point. Same protocol as AW Signer's worker: the app writes one JSON request on a line
to stdin, the worker answers with one or more JSON lines on stdout and exits. Diagnostics go to stderr.

Every answer has a "type" ("pong", "info", "saved", "split_done", "office_status", "converted",
"exported", "page_layer", "found" or "error"), and it is the last message.
"""

import json
import os
import sys

from . import __version__
from .commands import COMMANDS, WorkerError

_answers = None  # the real stdout, kept only for protocol messages (see main)


def send(message):
    out = _answers or sys.stdout
    out.write(json.dumps(message, ensure_ascii=False) + "\n")
    out.flush()


def _protect_answers():
    """Libraries print to stdout (pdf2docx progress, PyMuPDF notices), which would corrupt the
    JSON answers. Keep a private copy of stdout for answers, then point stdout, including the C-level
    file descriptor, at stderr, where diagnostics belong."""
    global _answers
    _answers = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def handle(line):
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        return {"type": "error", "error": "The request was not valid JSON."}
    if not isinstance(request, dict):
        return {"type": "error", "error": "The request must be a JSON object."}
    command = COMMANDS.get(request.get("command"))
    if command is None:
        return {"type": "error", "error": f"Unknown command: {request.get('command')!r}"}
    try:
        return command(request)
    except WorkerError as error:
        return {"type": "error", "error": str(error)}
    except Exception as error:  # never leave the app without an answer
        print(f"aw-pdf-worker {__version__}: {type(error).__name__}: {error}", file=sys.stderr)
        return {"type": "error", "error": "The PDF engine hit an unexpected problem with this file."}


def main():
    # UTF-8 pipes, so file names in Assamese, Bengali, Hindi or any script survive on Windows too.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    _protect_answers()
    line = sys.stdin.readline()
    if not line.strip():
        send({"type": "error", "error": "No request was received."})
        return 1
    send(handle(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
