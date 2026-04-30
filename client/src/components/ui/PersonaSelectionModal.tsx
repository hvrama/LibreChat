import { useEffect, useRef, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogTitle, useToastContext } from '@librechat/client';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { useUpdatePersonaMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

type Persona = {
  id: string;
  label: string;
  tagline: string;
  blurb: string;
  accent: string;
  accentSoft: string;
  prompts: string[];
};

const PERSONAS: Persona[] = [
  {
    id: 'general',
    label: 'General',
    tagline: 'Explore everything',
    blurb: 'A balanced overview across all modules — good if your role spans multiple areas.',
    accent: '#4C4DC2',
    accentSoft: '#E4E4F5',
    prompts: [
      'Default view: overview dashboard',
      'Show recent activity across modules',
      'Surface setup tips on login',
      'Weekly cross-team summary',
    ],
  },
  {
    id: 'networking',
    label: 'Networking',
    tagline: 'Network & infrastructure',
    blurb: 'Monitor connectivity, topology, throughput and device health across your environment.',
    accent: '#28B4EF',
    accentSoft: '#D5EFFB',
    prompts: [
      'Alert me on link failures over 30s',
      'Show top-talkers by VLAN',
      'Default view: topology map',
      'Hide decommissioned nodes',
    ],
  },
  {
    id: 'htm',
    label: 'HTM / BioMed',
    tagline: 'Clinical device management',
    blurb: 'Track medical devices, maintenance cycles, recalls and patient-impact risk.',
    accent: '#4BDA64',
    accentSoft: '#DAF6DF',
    prompts: [
      'Flag overdue PM inspections',
      'Group by care area',
      'Surface FDA recalls first',
      'Show devices in patient rooms',
    ],
  },
  {
    id: 'soc',
    label: 'SOC Analyst',
    tagline: 'Security operations',
    blurb: 'Investigate threats, triage alerts, hunt anomalies across endpoints and network.',
    accent: '#ED6169',
    accentSoft: '#FADFE1',
    prompts: [
      'Prioritize by MITRE tactic',
      'Auto-correlate by asset',
      'Default view: triage queue',
      'Suppress known-benign alerts',
    ],
  },
  {
    id: 'exec',
    label: 'Executive',
    tagline: 'Leadership overview',
    blurb: 'High-level posture, KPIs, trends and cross-team reporting at a glance.',
    accent: '#8D36B3',
    accentSoft: '#EADBF2',
    prompts: [
      'Weekly digest via email',
      'Default view: KPI board',
      'Hide technical detail',
      'Focus on trend deltas',
    ],
  },
  {
    id: 'endpoint',
    label: 'Endpoint Management',
    tagline: 'Vulnerability & patching',
    blurb: 'Track endpoint vulnerabilities, patch status and remediation across your fleet.',
    accent: '#28B4EF',
    accentSoft: '#D5EFFB',
    prompts: [
      'Prioritize critical CVEs',
      'Group by patch deadline',
      'Show unpatched endpoints',
      'Default view: compliance board',
    ],
  },
];

const GENERIC_PROMPTS = [
  'Default view: overview dashboard',
  'Show recent activity',
  'Weekly email digest',
  'Enable keyboard shortcuts',
];

const PersonaIllustration = ({ persona, size = 48 }: { persona: Persona; size?: number }) => {
  const { id, accent, accentSoft } = persona;
  const cardBg = 'var(--surface-primary)';
  const softBg = accentSoft;

  const shapes: Record<string, JSX.Element> = {
    networking: (
      <g>
        <circle cx="90" cy="90" r="62" fill={softBg} />
        <line x1="90" y1="45" x2="55" y2="95" stroke={accent} strokeWidth="2" />
        <line x1="90" y1="45" x2="125" y2="95" stroke={accent} strokeWidth="2" />
        <line x1="55" y1="95" x2="90" y2="135" stroke={accent} strokeWidth="2" />
        <line x1="125" y1="95" x2="90" y2="135" stroke={accent} strokeWidth="2" />
        <line
          x1="55"
          y1="95"
          x2="125"
          y2="95"
          stroke={accent}
          strokeWidth="2"
          strokeDasharray="3 4"
        />
        <circle cx="90" cy="45" r="9" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <circle cx="55" cy="95" r="9" fill={accent} />
        <circle cx="125" cy="95" r="9" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <circle cx="90" cy="135" r="9" fill={cardBg} stroke={accent} strokeWidth="2.5" />
      </g>
    ),
    htm: (
      <g>
        <rect x="28" y="28" width="124" height="124" rx="22" fill={softBg} />
        <path
          d="M40 95 H68 L78 75 L92 115 L102 90 L112 100 H140"
          fill="none"
          stroke={accent}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="140" cy="100" r="5" fill={accent} />
        <circle cx="40" cy="95" r="5" fill={accent} />
      </g>
    ),
    soc: (
      <g>
        <circle cx="90" cy="90" r="62" fill={softBg} />
        <path
          d="M90 45 L125 58 V92 C125 112 108 128 90 135 C72 128 55 112 55 92 V58 Z"
          fill={cardBg}
          stroke={accent}
          strokeWidth="2.5"
        />
        <path
          d="M75 90 L87 102 L108 78"
          fill="none"
          stroke={accent}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    ),
    exec: (
      <g>
        <rect x="28" y="28" width="124" height="124" rx="22" fill={softBg} />
        <rect x="52" y="95" width="16" height="35" rx="3" fill={accent} opacity="0.55" />
        <rect x="76" y="75" width="16" height="55" rx="3" fill={accent} opacity="0.75" />
        <rect x="100" y="60" width="16" height="70" rx="3" fill={accent} />
        <path
          d="M52 80 L84 60 L108 50 L128 40"
          fill="none"
          stroke={accent}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="128" cy="40" r="4" fill={accent} />
      </g>
    ),
    endpoint: (
      <g>
        <circle cx="90" cy="90" r="62" fill={softBg} />
        <rect
          x="55"
          y="62"
          width="70"
          height="46"
          rx="5"
          fill={cardBg}
          stroke={accent}
          strokeWidth="2.5"
        />
        <rect x="62" y="70" width="56" height="30" rx="2" fill={accent} opacity="0.18" />
        <rect x="48" y="108" width="84" height="6" rx="3" fill={accent} />
        <circle cx="120" cy="68" r="14" fill={accent} />
        <path
          d="M113 68 L118 73 L127 63"
          stroke={cardBg}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    ),
    general: (
      <g>
        <rect x="28" y="28" width="124" height="124" rx="22" fill={softBg} />
        <circle cx="90" cy="90" r="8" fill={accent} />
        <circle cx="90" cy="55" r="10" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <circle cx="90" cy="125" r="10" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <circle cx="55" cy="90" r="10" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <circle cx="125" cy="90" r="10" fill={cardBg} stroke={accent} strokeWidth="2.5" />
        <line x1="90" y1="82" x2="90" y2="65" stroke={accent} strokeWidth="2" />
        <line x1="90" y1="98" x2="90" y2="115" stroke={accent} strokeWidth="2" />
        <line x1="82" y1="90" x2="65" y2="90" stroke={accent} strokeWidth="2" />
        <line x1="98" y1="90" x2="115" y2="90" stroke={accent} strokeWidth="2" />
      </g>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 180 180"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {shapes[id]}
    </svg>
  );
};

const BulletRadio = ({ selected }: { selected: boolean }) => (
  <div
    className="flex shrink-0 items-center justify-center rounded-full border-2 transition-all"
    style={{
      width: 20,
      height: 20,
      borderColor: selected ? 'var(--text-primary)' : 'var(--border-medium)',
      background: selected ? 'var(--text-primary)' : 'transparent',
    }}
  >
    {selected && (
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--surface-primary)',
        }}
      />
    )}
  </div>
);

const PersonaTile = ({
  persona,
  selected,
  onSelect,
}: {
  persona: Persona;
  selected: boolean;
  onSelect: (id: string) => void;
}) => (
  <button
    type="button"
    onClick={() => onSelect(persona.id)}
    aria-pressed={selected}
    className="flex flex-col gap-2.5 rounded-xl bg-surface-primary p-4 text-left transition-all hover:-translate-y-0.5"
    style={{
      border: `${selected ? 2 : 1}px solid ${selected ? 'var(--text-primary)' : 'var(--border-light)'}`,
      padding: selected ? '15px 15px 17px' : '16px 16px 18px',
      boxShadow: selected
        ? '0 8px 24px -10px rgba(0,0,0,0.18), 0 0 0 3px rgba(0,0,0,0.05)'
        : '0 1px 2px rgba(0,0,0,0.03)',
    }}
  >
    <div className="flex items-start justify-between gap-2">
      <div
        className="grid shrink-0 place-items-center rounded-xl"
        style={{
          width: 56,
          height: 56,
          background: persona.accentSoft,
        }}
      >
        <PersonaIllustration persona={persona} size={48} />
      </div>
      <BulletRadio selected={selected} />
    </div>
    <div>
      <div
        className="font-semibold text-text-primary"
        style={{ fontSize: 15, letterSpacing: '-0.01em', lineHeight: 1.2 }}
      >
        {persona.label}
      </div>
      <div
        className="font-semibold uppercase text-text-tertiary"
        style={{ fontSize: 10, letterSpacing: '0.1em', marginTop: 4 }}
      >
        {persona.tagline}
      </div>
    </div>
    <div className="text-text-secondary" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
      {persona.blurb}
    </div>
  </button>
);

const PersonaGrid = ({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
    {PERSONAS.map((persona) => (
      <PersonaTile
        key={persona.id}
        persona={persona}
        selected={persona.id === selectedId}
        onSelect={onSelect}
      />
    ))}
  </div>
);

const PreferencesField = ({
  persona,
  value,
  onChange,
}: {
  persona: Persona | null;
  value: string;
  onChange: (next: string) => void;
}) => {
  const localize = useLocalize();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusColor = persona?.accent ?? 'var(--text-primary)';
  const prompts = persona?.prompts ?? GENERIC_PROMPTS;
  const placeholder = persona
    ? localize('com_ui_persona_preferences_placeholder_role', { 0: persona.label })
    : localize('com_ui_persona_preferences_placeholder_norole');

  const addPrompt = (prompt: string) => {
    const cur = value.trim();
    const next = cur ? `${cur}\n• ${prompt}` : `• ${prompt}`;
    onChange(next);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <label
          htmlFor="persona-preferences-textarea"
          className="font-semibold text-text-primary"
          style={{ fontSize: 13, letterSpacing: '-0.005em' }}
        >
          {localize('com_ui_persona_preferences_label')}
        </label>
        <span className="text-text-tertiary" style={{ fontSize: 11 }}>
          {localize('com_ui_persona_preferences_optional')}
        </span>
      </div>
      <textarea
        id="persona-preferences-textarea"
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-xl border bg-surface-secondary text-text-primary outline-none transition-colors"
        style={{
          padding: '12px 14px',
          borderColor: 'var(--border-light)',
          fontSize: 14,
          lineHeight: 1.5,
        }}
        onFocus={(e) => {
          e.target.style.borderColor = focusColor;
          e.target.style.boxShadow = `0 0 0 3px ${focusColor}26`;
        }}
        onBlur={(e) => {
          e.target.style.borderColor = 'var(--border-light)';
          e.target.style.boxShadow = 'none';
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="font-medium text-text-tertiary"
          style={{ fontSize: 11, marginRight: 4, letterSpacing: '0.02em' }}
        >
          {persona ? localize('com_ui_persona_suggested') : localize('com_ui_persona_examples')}
        </span>
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => addPrompt(p)}
            className="rounded-full border bg-surface-primary font-medium text-text-primary transition-colors hover:bg-surface-tertiary"
            style={{
              padding: '6px 12px',
              borderColor: 'var(--border-light)',
              fontSize: 12,
            }}
          >
            + {p}
          </button>
        ))}
      </div>
    </div>
  );
};

const SaveButton = ({
  enabled,
  onClick,
  label,
}: {
  enabled: boolean;
  onClick: () => void;
  label: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!enabled}
    className="inline-flex h-10 items-center justify-center rounded-lg border border-border-heavy bg-surface-secondary px-4 py-2 text-sm text-text-primary transition-colors hover:bg-green-500 hover:text-white focus:bg-green-500 focus:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-secondary disabled:hover:text-text-primary dark:hover:bg-green-600 dark:focus:bg-green-600"
  >
    {label}
  </button>
);

const PersonaSelectionModal = ({
  open,
  onOpenChange,
  initialPersona,
  initialDescription,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPersona?: string;
  initialDescription?: string;
  onSaved?: () => void;
}) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const initialId = PERSONAS.find((p) => p.label === initialPersona)?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [prefs, setPrefs] = useState<string>(initialDescription ?? '');

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedId(PERSONAS.find((p) => p.label === initialPersona)?.id ?? null);
    setPrefs(initialDescription ?? '');
  }, [open, initialPersona, initialDescription]);

  const updatePersona = useUpdatePersonaMutation({
    onSuccess: () => {
      onSaved?.();
      onOpenChange(false);
    },
    onError: () => {
      showToast({ message: localize('com_ui_persona_save_error') });
    },
  });

  const persona = PERSONAS.find((p) => p.id === selectedId) ?? null;

  const handleSave = () => {
    if (!persona) {
      return;
    }
    updatePersona.mutate({
      persona: persona.label,
      personaDescription: prefs,
    });
  };

  const handleSkip = () => {
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (open && !next) {
      return;
    }
    onOpenChange(next);
  };

  return (
    <OGDialog open={open} onOpenChange={handleOpenChange}>
      <OGDialogContent
        showCloseButton={false}
        className="w-11/12 max-w-3xl gap-0 p-0 sm:w-3/4 md:w-3/4 lg:w-3/5"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <VisuallyHidden.Root>
          <OGDialogTitle>
            {localize('com_ui_persona_modal_title_prefix')}{' '}
            {localize('com_ui_persona_modal_title_emphasis')}{' '}
            {localize('com_ui_persona_modal_title_suffix')}
          </OGDialogTitle>
        </VisuallyHidden.Root>
        <div className="flex flex-col" style={{ gap: 22, padding: '32px 32px 28px' }}>
          <div className="flex flex-col gap-1.5 text-center">
            <h1
              className="text-text-primary"
              style={{
                margin: 0,
                fontSize: 28,
                lineHeight: 1.15,
                letterSpacing: '-0.025em',
                fontWeight: 700,
              }}
            >
              {localize('com_ui_persona_modal_title_prefix')}{' '}
              <em style={{ fontStyle: 'italic' }}>
                {localize('com_ui_persona_modal_title_emphasis')}
              </em>{' '}
              {localize('com_ui_persona_modal_title_suffix')}
            </h1>
            <p
              className="text-text-secondary"
              style={{
                margin: 0,
                fontSize: 13.5,
                maxWidth: 520,
                marginInline: 'auto',
                lineHeight: 1.5,
              }}
            >
              {localize('com_ui_persona_modal_subtitle')}
            </p>
          </div>

          <PersonaGrid selectedId={selectedId} onSelect={setSelectedId} />

          <div
            style={{
              borderTop: '1px solid var(--border-light)',
              paddingTop: 20,
            }}
          >
            <PreferencesField persona={persona} value={prefs} onChange={setPrefs} />
          </div>

          <div className="mt-1 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleSkip}
              className="bg-transparent px-1 py-2 font-medium text-text-tertiary hover:text-text-secondary"
              style={{ fontSize: 13 }}
            >
              {localize('com_ui_persona_skip')}
            </button>
            <SaveButton
              enabled={!!selectedId && !updatePersona.isLoading}
              onClick={handleSave}
              label={localize('com_ui_persona_save')}
            />
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
};

export default PersonaSelectionModal;
