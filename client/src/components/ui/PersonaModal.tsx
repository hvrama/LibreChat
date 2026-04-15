import { useState } from 'react';
import { OGDialog, DialogTemplate, Dropdown, useToastContext } from '@librechat/client';
import { useUpdatePersonaMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

const personaOptions = ['General', 'BioMED', 'SOC Analyst', 'Networking and IT'];

const PersonaModal = ({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onSave: () => void;
}) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [persona, setPersona] = useState('');
  const [personaDescription, setPersonaDescription] = useState('');

  const updatePersonaMutation = useUpdatePersonaMutation({
    onSuccess: () => {
      onSave();
      onOpenChange(false);
    },
    onError: () => {
      showToast({ message: localize('com_ui_persona_update_failed') });
    },
  });

  const handleSave = () => {
    if (!persona) {
      return;
    }
    updatePersonaMutation.mutate({ persona, personaDescription });
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (open && !isOpen) {
      return;
    }
    onOpenChange(isOpen);
  };

  return (
    <OGDialog open={open} onOpenChange={handleOpenChange}>
      <DialogTemplate
        title={localize('com_ui_select_persona') ?? 'Select Your Persona'}
        className="w-11/12 max-w-3xl sm:w-3/4 md:w-1/2 lg:w-2/5"
        showCloseButton={false}
        showCancelButton={false}
        main={
          <section tabIndex={0} className="max-h-[60vh] overflow-y-auto p-4">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-text-primary">
                  {localize('com_ui_persona') ?? 'Persona'}
                </label>
                <Dropdown
                  value={persona}
                  onChange={setPersona}
                  options={personaOptions}
                  portal={false}
                  testId="persona-dropdown"
                  ariaLabel={localize('com_ui_select_persona') ?? 'Select Your Persona'}
                />
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_persona_helper') ??
                    'Choose a persona that best matches your role. This helps tailor responses to your needs.'}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-text-primary">
                  {localize('com_ui_persona_description') ?? 'Persona Description'}
                </label>
                <textarea
                  value={personaDescription}
                  onChange={(e) => setPersonaDescription(e.target.value)}
                  placeholder={
                    localize('com_ui_persona_description_placeholder') ??
                    'Describe your persona...'
                  }
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border-heavy bg-surface-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-xheavy focus:outline-none"
                />
              </div>
            </div>
          </section>
        }
        buttons={
          <button
            onClick={handleSave}
            disabled={!persona || updatePersonaMutation.isLoading}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border-heavy bg-surface-secondary px-4 py-2 text-sm text-text-primary hover:bg-green-500 hover:text-white focus:bg-green-500 focus:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-green-600 dark:focus:bg-green-600"
          >
            {localize('com_ui_save') ?? 'Save'}
          </button>
        }
      />
    </OGDialog>
  );
};

export default PersonaModal;
