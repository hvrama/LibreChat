import React, { useState } from 'react';
import { MenuButton } from '@ariakit/react';
import { Printer, File, Files } from 'lucide-react';
import { DropdownPopup, TooltipAnchor, Button, useMediaQuery } from '@librechat/client';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react';
import type { ArtifactPrintMode, ArtifactPrintMessage } from '~/utils/print';
import { ARTIFACT_PRINT_MESSAGE } from '~/utils/print';
import { useLocalize } from '~/hooks';

interface PrintArtifactProps {
  previewRef: React.MutableRefObject<SandpackPreviewRef | undefined>;
}

export default function PrintArtifact({ previewRef }: PrintArtifactProps) {
  const localize = useLocalize();
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const menuId = 'print-artifact-dropdown-menu';

  const handlePrint = (mode: ArtifactPrintMode) => {
    setIsPopoverActive(false);
    const client = previewRef.current?.getClient();
    if (!client) {
      return;
    }
    const message: ArtifactPrintMessage = { type: ARTIFACT_PRINT_MESSAGE, mode };
    client.iframe.contentWindow?.postMessage(message, '*');
  };

  const dropdownItems = [
    {
      label: localize('com_ui_save_pdf_single_page'),
      onClick: () => handlePrint('single'),
      icon: <File size={16} className="text-text-secondary" aria-hidden="true" />,
    },
    {
      label: localize('com_ui_save_pdf_multi_page'),
      onClick: () => handlePrint('paged'),
      icon: <Files size={16} className="text-text-secondary" aria-hidden="true" />,
    },
  ];

  return (
    <DropdownPopup
      menuId={menuId}
      portal
      focusLoop
      unmountOnHide
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      trigger={
        <TooltipAnchor
          description={localize('com_ui_save_as_pdf')}
          render={
            <Button size="icon" variant="ghost" asChild aria-label={localize('com_ui_save_as_pdf')}>
              <MenuButton>
                <Printer
                  size={18}
                  className="text-text-secondary"
                  aria-hidden="true"
                  focusable="false"
                />
              </MenuButton>
            </Button>
          }
        />
      }
      items={dropdownItems}
      className={isSmallScreen ? '' : 'absolute right-0 top-0 mt-2'}
    />
  );
}
