// Line icons standing in for the SF Symbols the Mac app uses. Drawn on a 24-unit grid, stroke only.
const PATHS = {
  signature: ["M3 16c3 0 4-8 6-8s1 6 3 6 2-4 4-4 2 3 5 3", "M3 20h18"],
  clock: ["C12 12 9", "M12 7v5l3 2"],
  layers: ["M12 3 2 8l10 5 10-5-10-5z", "M2 12.5l10 5 10-5", "M2 17l10 5 10-5"],
  seal: ["C12 12 9", "M8 12l3 3 5-6"],
  help: ["C12 12 9", "M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.5v.4", "M12 17h.01"],
  settings: ["C12 12 3", "M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"],
  file: ["M14 3H6.5a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5", "M9 13h6M9 17h6"],
  fileFilled: ["M14 3H6.5a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5"],
  fileOne: ["M14 3H6.5a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5", "M11 12h1.5v6"],
  files: ["M9 3h7l4 4v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M5 7v13a1 1 0 0 0 1 1h9"],
  folder: ["M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"],
  checkCircle: ["C12 12 9", "M8 12l3 3 5-6"],
  alertCircle: ["C12 12 9", "M12 7.5v5.5", "M12 16.5h.01"],
  info: ["C12 12 9", "M12 11v5.5", "M12 7.5h.01"],
  x: ["M6 6l12 12M18 6 6 18"],
  xCircle: ["C12 12 9", "M9 9l6 6M15 9l-6 6"],
  minusCircle: ["C12 12 9", "M8 12h8"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  user: ["C12 12 9.5", "C12 10 3", "M6.6 18.8a6.5 6.5 0 0 1 10.8 0"],
  lock: ["M5.5 11h13v10h-13z", "M8 11V8a4 4 0 0 1 8 0v3"],
  eye: ["M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z", "C12 12 3"],
  eyeOff: ["M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z", "C12 12 3", "M3 3l18 18"],
  usb: ["M8 8h8v6a4 4 0 0 1-8 0z", "M10 3v5M14 3v5", "M12 18v3.5"],
  expand: ["M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"],
  warn: ["M12 3.5 2.5 20h19z", "M12 10v4.5", "M12 17h.01"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  bookmark: ["M6.5 3.5h11V21L12 17l-5.5 4z"],
  plus: ["M12 5v14M5 12h14"],
  radioOff: ["C12 12 8.5"],
  clockAlert: ["C12 12 9", "M12 7v5l3 2", "M19 19l2 2"],
  // AW PDF Editor additions (same 24-unit grid, stroke only)
  home: ["M3.5 11 12 4l8.5 7", "M6 9.5V20h12V9.5", "M10 20v-5h4v5"],
  zoomIn: ["C11 11 6.5", "M16 16l4.5 4.5", "M11 8.5v5M8.5 11h5"],
  zoomOut: ["C11 11 6.5", "M16 16l4.5 4.5", "M8.5 11h5"],
  fitWidth: ["M3 5v14M21 5v14", "M7 12h10", "M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5"],
  chevronLeft: ["M15 5l-7 7 7 7"],
  chevronRight: ["M9 5l7 7-7 7"],
  pages: ["M8 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M4 7v13a1 1 0 0 0 1 1h10"],
  grid: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  rotateLeft: ["M4 4v5h5", "M4.6 9A8 8 0 1 1 4 13"],
  rotateRight: ["M20 4v5h-5", "M19.4 9A8 8 0 1 0 20 13"],
  trash: ["M4 7h16", "M9.5 7V4.5h5V7", "M6.5 7l1 13h9l1-13", "M10 11v5.5M14 11v5.5"],
  duplicate: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  crop: ["M6 2v16h16", "M2 6h16v16"],
  split: ["M6 3h8l4 4v4", "M6 3v8", "M3 14h18", "M6 17v4h12v-4"],
  merge: ["M5 3h6v7H5zM13 3h6v7h-6z", "M8 10v3h8v-3", "M12 13v4", "M9 15l3 3 3-3", "M7 21h10"],
  undo: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"],
  redo: ["M15 14l5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"],
  insert: ["M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5", "M12 11v6M9 14h6"],
  replace: ["M4 7h12l-3-3M20 17H8l3 3", "M16 7l-3 3M8 17l3-3"],
  extract: ["M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5", "M12 17v-6M9 14l3 3 3-3"],
  save: ["M5 4h11l3 3v13H5z", "M8 4v5h7V4", "M8 20v-6h8v6"],
  selectAll: ["M4 4h16v16H4z", "M8 12l3 3 5-6"],
  create: ["M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z", "M14 3v5h5", "M9 13l2 2 4-4"],
  export: ["M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h5", "M14 3v5h5", "M15 17h6M18 14l3 3-3 3"],
  cursor: ["M5 3l13 7-6 1.5L9.5 18z", "M12 11.5l5 6"],
  pen: ["M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z", "M14 7l3 3"],
  highlighter: ["M4 20h7", "M8 16l-2 2", "M8 16l3 3 9-9-6-6-9 9z", "M11 13l3 3"],
  underline: ["M7 4v6a5 5 0 0 0 10 0V4", "M5 20h14"],
  strike: ["M16.5 7.5C16 5.8 14.3 4.5 12 4.5c-2.6 0-4.5 1.5-4.5 3.5 0 4.5 9 3 9 8 0 2-2 3.5-4.5 3.5-2.4 0-4.2-1.3-4.8-3", "M4 12h16"],
  note: ["M5 4h14v11l-5 5H5z", "M14 20v-5h5", "M8 9h8M8 12.5h5"],
  textT: ["M5 6V4h14v2", "M12 4v16", "M9 20h6"],
  square: ["M4.5 4.5h15v15h-15z"],
  circle: ["C12 12 8"],
  lineTool: ["M5 19L19 5"],
  arrowTool: ["M5 19L19 5", "M10 5h9v9"],
  stampTool: ["M9.5 3.5h5l-1 7h-3z", "M5 14.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V17H5z", "M4 20.5h16"],
  picture: ["M4 5h16v14H4z", "C9 10 1.6", "M4 17l5-5 4 4 3-3 4 4"],
  watermark: ["M4 20L20 4", "M7 4h13v13", "M4 7v13h13"],
  hash: ["M9 4L7 20M17 4l-2 16", "M4.5 9h15M3.5 15h15"],
  comments: ["M4 5h16v10H9l-5 4z", "M8 9h8M8 12h5"],
  redact: ["M4 6h16M4 11h7M4 16h5", "M13 10h7v8h-7z"],
  textEdit: ["M4 6V4h11v2", "M9.5 4v13", "M7 17h5", "M14 20l1-3.5 5.5-5.5a1.5 1.5 0 0 1 2 2L17 18.5z"],
  search: ["C10.5 10.5 6.5", "M15.5 15.5 21 21"],
  back: ["M19 12H5", "M11 18l-6-6 6-6"],
  forward: ["M5 12h14", "M13 6l6 6-6 6"],
  present: ["M3 4h18v12H3z", "M12 16v4M8 20h8"],
  ocr: ["M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3", "M8 9h8M8 12h8M8 15h5"],
  compress: ["M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"],
  batch: ["M7 3h10v4H7zM4 10h16v4H4zM7 17h10v4H7z"],
};

const NS = "http://www.w3.org/2000/svg";

/** An <svg> for one icon. "C cx cy r" entries are circles; everything else is a path. */
export function icon(name, extraClass = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (extraClass) svg.setAttribute("class", extraClass);
  for (const part of PATHS[name] || []) {
    let element;
    if (part.startsWith("C")) {
      const [cx, cy, r] = part.slice(1).trim().split(/\s+/);
      element = document.createElementNS(NS, "circle");
      element.setAttribute("cx", cx);
      element.setAttribute("cy", cy);
      element.setAttribute("r", r);
    } else {
      element = document.createElementNS(NS, "path");
      element.setAttribute("d", part);
    }
    svg.append(element);
  }
  return svg;
}

/** A filled radio dot for selected cards and certificates. */
export function radio(on) {
  const svg = icon("radioOff", "radio");
  if (on) {
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "4.5");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}
