import dedent from 'dedent';

export const ARTIFACT_PRINT_MESSAGE = 'librechat:print-artifact';

export type ArtifactPrintMode = 'single' | 'paged';

export interface ArtifactPrintMessage {
  type: typeof ARTIFACT_PRINT_MESSAGE;
  mode: ArtifactPrintMode;
}

export const PRINT_STYLE_ID = 'librechat-print-page';

/**
 * Runs inside the Sandpack preview iframe. The preview is cross-origin, so the
 * panel cannot call `print()` on it directly; instead it posts an
 * `ArtifactPrintMessage` and this listener prints from within. `single` mode
 * sizes a custom `@page` to the whole document so the artifact lands on one
 * page; `paged` mode leaves pagination to the browser. The injected style is
 * removed on `afterprint` so the on-screen preview is unaffected.
 */
export const printListenerScript = dedent(`(function () {
  var MESSAGE = '${ARTIFACT_PRINT_MESSAGE}';
  var STYLE_ID = '${PRINT_STYLE_ID}';
  function removePageStyle() {
    var style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) {
      style.parentNode.removeChild(style);
    }
  }
  function fitToOnePage() {
    var root = document.documentElement;
    var body = document.body;
    var width = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    var height = Math.max(root.scrollHeight, body ? body.scrollHeight : 0);
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '@page { size: ' + width + 'px ' + height + 'px; margin: 0; }' +
      ' @media print { html, body { overflow: visible !important; } }';
    document.head.appendChild(style);
  }
  window.addEventListener('afterprint', removePageStyle);
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== MESSAGE) {
      return;
    }
    removePageStyle();
    if (data.mode === 'single') {
      fitToOnePage();
    }
    window.print();
  });
})();`);

const PRINT_SCRIPT_TAG = `<script>${printListenerScript}</script>`;

const HEAD_CLOSE = /<\/head\s*>/i;
const BODY_CLOSE = /<\/body\s*>/i;

const insertBefore = (html: string, index: number): string =>
  `${html.slice(0, index)}${PRINT_SCRIPT_TAG}${html.slice(index)}`;

/** Adds the print listener to a complete HTML document (idempotent). */
export function injectPrintListener(html: string): string {
  if (html.includes(PRINT_SCRIPT_TAG)) {
    return html;
  }
  const headClose = html.search(HEAD_CLOSE);
  if (headClose !== -1) {
    return insertBefore(html, headClose);
  }
  const bodyClose = html.search(BODY_CLOSE);
  if (bodyClose !== -1) {
    return insertBefore(html, bodyClose);
  }
  return `${html}${PRINT_SCRIPT_TAG}`;
}

type SandpackFile = string | { code: string } | undefined;

/** Applies `injectPrintListener` to the `index.html` entry of a static-template file map. */
export function injectPrintListenerIntoFiles<T extends Record<string, SandpackFile>>(
  files: T,
  fileName = 'index.html',
): T {
  const entry = files[fileName];
  if (entry == null) {
    return files;
  }
  const injected =
    typeof entry === 'string'
      ? injectPrintListener(entry)
      : { ...entry, code: injectPrintListener(entry.code) };
  return { ...files, [fileName]: injected };
}

/** Sandpack `react-ts` entry file that registers the print listener before rendering `App`. */
export const reactEntryWithPrint = dedent(`import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./print";

import App from "./App";

const root = createRoot(document.getElementById("root"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);`);
