import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react';
import { ARTIFACT_PRINT_MESSAGE } from '~/utils/print';
import PrintArtifact from '../PrintArtifact';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

/* The real DropdownPopup pulls ESM-only ariakit subpaths jest cannot resolve;
 * render the trigger plus one button per item so the click wiring is exercised. */
jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
  Button: ({
    children,
    asChild: _asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    _asChild ? <>{children}</> : <button {...props}>{children}</button>,
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => <>{content}</>,
  DropdownPopup: ({
    trigger,
    items,
  }: {
    trigger: React.ReactNode;
    items: { label: string; onClick: () => void }[];
  }) => (
    <div>
      {trigger}
      <ul role="menu">
        {items.map((item) => (
          <li key={item.label}>
            <button type="button" role="menuitem" onClick={item.onClick}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}));

const makePreviewRef = (postMessage: jest.Mock | null) => {
  const client =
    postMessage == null
      ? null
      : ({ iframe: { contentWindow: { postMessage } } } as unknown as ReturnType<
          SandpackPreviewRef['getClient']
        >);
  return { current: { clientId: 'c1', getClient: () => client } as SandpackPreviewRef };
};

describe('PrintArtifact', () => {
  it('renders both page-layout options', () => {
    render(<PrintArtifact previewRef={makePreviewRef(jest.fn())} />);
    expect(screen.getByRole('menuitem', { name: 'com_ui_save_pdf_single_page' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'com_ui_save_pdf_multi_page' })).toBeTruthy();
  });

  it('posts a single-page print message to the preview iframe', () => {
    const postMessage = jest.fn();
    render(<PrintArtifact previewRef={makePreviewRef(postMessage)} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'com_ui_save_pdf_single_page' }));
    expect(postMessage).toHaveBeenCalledWith({ type: ARTIFACT_PRINT_MESSAGE, mode: 'single' }, '*');
  });

  it('posts a paged print message to the preview iframe', () => {
    const postMessage = jest.fn();
    render(<PrintArtifact previewRef={makePreviewRef(postMessage)} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'com_ui_save_pdf_multi_page' }));
    expect(postMessage).toHaveBeenCalledWith({ type: ARTIFACT_PRINT_MESSAGE, mode: 'paged' }, '*');
  });

  it('does nothing when no preview client is mounted', () => {
    render(<PrintArtifact previewRef={makePreviewRef(null)} />);
    expect(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'com_ui_save_pdf_single_page' })),
    ).not.toThrow();
  });
});
