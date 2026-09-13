import {
  PRINT_STYLE_ID,
  reactEntryWithPrint,
  printListenerScript,
  injectPrintListener,
  ARTIFACT_PRINT_MESSAGE,
  injectPrintListenerIntoFiles,
} from '~/utils/print';

const scriptTag = `<script>${printListenerScript}</script>`;

describe('print utilities', () => {
  describe('injectPrintListener', () => {
    it('inserts the listener before </head> when a head is present', () => {
      const html = '<html><head><title>t</title></head><body><p>x</p></body></html>';
      const result = injectPrintListener(html);
      expect(result.indexOf(scriptTag)).toBeLessThan(result.indexOf('</head>'));
      expect(result.indexOf(scriptTag)).toBeGreaterThan(result.indexOf('<title>'));
    });

    it('falls back to </body> when there is no head', () => {
      const html = '<html><body><p>x</p></body></html>';
      const result = injectPrintListener(html);
      expect(result).toBe(`<html><body><p>x</p>${scriptTag}</body></html>`);
    });

    it('appends when neither head nor body closing tags exist', () => {
      const html = '<h1>hello</h1>';
      expect(injectPrintListener(html)).toBe(`${html}${scriptTag}`);
    });

    it('matches closing tags case-insensitively', () => {
      const html = '<HTML><BODY>x</BODY></HTML>';
      expect(injectPrintListener(html)).toBe(`<HTML><BODY>x${scriptTag}</BODY></HTML>`);
    });

    it('is idempotent', () => {
      const once = injectPrintListener('<html><body>x</body></html>');
      expect(injectPrintListener(once)).toBe(once);
    });

    it('emits a script that references the print message type', () => {
      expect(printListenerScript).toContain(ARTIFACT_PRINT_MESSAGE);
      expect(printListenerScript).not.toContain('</script>');
    });
  });

  describe('injectPrintListenerIntoFiles', () => {
    it('injects into a string index.html entry', () => {
      const files = { 'index.html': '<html><body>x</body></html>', 'other.txt': 'y' };
      const result = injectPrintListenerIntoFiles(files);
      expect(result['index.html']).toContain(scriptTag);
      expect(result['other.txt']).toBe('y');
    });

    it('injects into a { code } index.html entry', () => {
      const files = { 'index.html': { code: '<html><body>x</body></html>' } };
      const result = injectPrintListenerIntoFiles(files);
      expect(result['index.html'].code).toContain(scriptTag);
    });

    it('returns the same object when the entry is missing', () => {
      const files = { 'content.md': '# hi' };
      expect(injectPrintListenerIntoFiles(files)).toBe(files);
    });
  });

  describe('reactEntryWithPrint', () => {
    it('imports the print module before rendering App', () => {
      expect(reactEntryWithPrint).toContain('import "./print";');
      expect(reactEntryWithPrint).toContain('import App from "./App";');
      expect(reactEntryWithPrint.indexOf('import "./print";')).toBeLessThan(
        reactEntryWithPrint.indexOf('import App'),
      );
    });
  });

  describe('printListenerScript runtime behaviour', () => {
    let print: jest.Mock;

    const post = (data: unknown, source: Window | null = window) => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    };

    beforeAll(() => {
      Object.defineProperty(document.documentElement, 'scrollWidth', {
        configurable: true,
        value: 640,
      });
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        value: 2400,
      });
      new Function(printListenerScript)();
    });

    beforeEach(() => {
      print = jest.fn();
      Object.defineProperty(window, 'print', { configurable: true, value: print });
    });

    afterEach(() => {
      document.getElementById(PRINT_STYLE_ID)?.remove();
    });

    it('prints without a page style in paged mode', () => {
      post({ type: ARTIFACT_PRINT_MESSAGE, mode: 'paged' });
      expect(print).toHaveBeenCalledTimes(1);
      expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
    });

    it('sizes a single page to the document in single mode and cleans up after printing', () => {
      post({ type: ARTIFACT_PRINT_MESSAGE, mode: 'single' });
      expect(print).toHaveBeenCalledTimes(1);
      const style = document.getElementById(PRINT_STYLE_ID);
      expect(style?.textContent).toContain('@page { size: 640px 2400px; margin: 0; }');
      window.dispatchEvent(new Event('afterprint'));
      expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
    });

    it('ignores messages with a different type', () => {
      post({ type: 'something-else', mode: 'single' });
      expect(print).not.toHaveBeenCalled();
    });

    it('ignores messages that did not come from the parent window', () => {
      post({ type: ARTIFACT_PRINT_MESSAGE, mode: 'paged' }, null);
      expect(print).not.toHaveBeenCalled();
    });
  });
});
