import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TPromptGroup, TPromptGroupSchedule } from 'librechat-data-provider';

const GROUP_ID = '74a1f0c2e4b0a1b2c3d4e5f6';

const mockUpdateMutate = jest.fn();
const mockClearMutate = jest.fn();
const mockRunMutate = jest.fn();
const mockShowToast = jest.fn();
let mockStartupConfig: { scheduledPrompts?: { enabled: boolean; minIntervalMinutes: number } } = {
  scheduledPrompts: { enabled: true, minIntervalMinutes: 1440 },
};
let mockRuns: unknown[] = [];

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useUpdatePromptGroup: () => ({ mutate: mockUpdateMutate, isLoading: false }),
  useClearPromptGroupSchedule: () => ({ mutate: mockClearMutate, isLoading: false }),
  useRunPromptGroupSchedule: () => ({ mutate: mockRunMutate, isLoading: false }),
  useGetPromptGroupScheduleRuns: (_id: string, config?: { enabled?: boolean }) => ({
    data: config?.enabled ? mockRuns : undefined,
  }),
  useGetPromptGroupScheduleRecipients: () => ({ data: undefined }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({
    agent_1: { id: 'agent_1', name: 'Reporter' },
    agent_2: { id: 'agent_2', name: 'Analyst' },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Share/MessageIcon', () => () => null);

jest.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  const Select = ({
    items,
    options,
    selectedValue,
    value,
    setValue,
    onChange,
    ariaLabel,
  }: {
    items?: { label?: string; value: string }[];
    options?: { label?: string; value: string }[];
    selectedValue?: string;
    value?: string;
    setValue?: (v: string) => void;
    onChange?: (v: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={selectedValue ?? value ?? ''}
      onChange={(e) => (setValue ?? onChange)?.(e.target.value)}
    >
      <option value="">-</option>
      {(items ?? options ?? []).map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
  return {
    ...actual,
    ControlCombobox: Select,
    Dropdown: Select,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

import ScheduleSection from '../ScheduleSection';

const schedule = (overrides: Partial<TPromptGroupSchedule> = {}): TPromptGroupSchedule => ({
  user: 'u1',
  agent_id: 'agent_1',
  cron: '0 9 * * *',
  timezone: 'UTC',
  source: { kind: 'preset', preset: 'daily' as never, time: '09:00' },
  variables: {},
  enabled: true,
  notify: { email: true },
  nextRunAt: '2026-09-15T09:00:00.000Z',
  lastRunAt: '2026-09-14T09:00:00.000Z',
  lastRunStatus: 'succeeded' as never,
  lastConversationId: 'convo-1',
  runCount: 3,
  consecutiveFailures: 0,
  ...overrides,
});

const group = (overrides: Partial<TPromptGroup> = {}): TPromptGroup => ({
  _id: GROUP_ID,
  name: 'Daily digest',
  author: 'u1',
  authorName: 'Ada',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStartupConfig = { scheduledPrompts: { enabled: true, minIntervalMinutes: 1440 } };
  mockRuns = [];
});

describe('ScheduleSection', () => {
  it('renders nothing when the feature is disabled', () => {
    mockStartupConfig = { scheduledPrompts: { enabled: false, minIntervalMinutes: 1440 } };
    const { container } = render(
      <ScheduleSection group={group()} promptText="Hello" canEdit={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for viewers when the group has no schedule', () => {
    const { container } = render(
      <ScheduleSection group={group()} promptText="Hello" canEdit={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('saves a daily preset schedule with prompt variables', () => {
    render(
      <ScheduleSection
        group={group()}
        promptText="Report for {{region}} on {{current_date}}"
        canEdit={true}
      />,
    );
    fireEvent.change(screen.getByLabelText('com_ui_agent'), { target: { value: 'agent_2' } });
    fireEvent.change(screen.getByLabelText('region'), { target: { value: 'EMEA' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_save' }));

    expect(mockUpdateMutate).toHaveBeenCalledWith({
      id: GROUP_ID,
      payload: {
        schedule: {
          agent_id: 'agent_2',
          source: { kind: 'preset', preset: 'daily', time: '09:00' },
          timezone: expect.any(String),
          variables: { region: 'EMEA' },
          notify: { email: false },
        },
      },
    });
  });

  it('requires an agent before saving', () => {
    render(<ScheduleSection group={group()} promptText="Hello" canEdit={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_save' }));
    expect(mockUpdateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_schedule_agent_required');
  });

  it('saves a custom cron schedule and rejects malformed cron', () => {
    render(<ScheduleSection group={group()} promptText="Hello" canEdit={true} />);
    fireEvent.change(screen.getByLabelText('com_ui_agent'), { target: { value: 'agent_1' } });
    fireEvent.change(screen.getByLabelText('com_ui_schedule_frequency'), {
      target: { value: 'custom' },
    });
    const cronInput = screen.getByLabelText('com_ui_schedule_custom_cron');
    fireEvent.change(cronInput, { target: { value: '0 9 * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_save' }));
    expect(mockUpdateMutate).not.toHaveBeenCalled();

    fireEvent.change(cronInput, { target: { value: '30 8 * * 1-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_save' }));
    expect(mockUpdateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          schedule: expect.objectContaining({ source: { kind: 'cron', cron: '30 8 * * 1-5' } }),
        },
      }),
    );
  });

  it('shows status for an existing schedule and toggles enabled with a partial patch', () => {
    render(
      <ScheduleSection group={group({ schedule: schedule() })} promptText="Hello" canEdit={true} />,
    );
    expect(screen.getByText('Reporter · 0 9 * * * · UTC')).toBeInTheDocument();
    expect(screen.getByText('com_ui_schedule_status_succeeded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'com_ui_schedule_enabled' }));
    expect(mockUpdateMutate).toHaveBeenCalledWith({
      id: GROUP_ID,
      payload: { schedule: { enabled: false } },
    });
  });

  it('runs now, lists run history, and removes after confirmation', () => {
    mockRuns = [
      { _id: 'r1', status: 'failed', startedAt: '2026-09-13T09:00:00.000Z', warnings: [] },
    ];
    render(
      <ScheduleSection group={group({ schedule: schedule() })} promptText="Hello" canEdit={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_run_now' }));
    expect(mockRunMutate).toHaveBeenCalledWith(GROUP_ID);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_runs' }));
    expect(screen.getByText('com_ui_schedule_status_failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_remove' }));
    expect(mockClearMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_schedule_remove' })[0]);
    expect(mockClearMutate).toHaveBeenCalledWith(GROUP_ID);
  });

  it('hides editing controls for viewers but shows status', () => {
    render(
      <ScheduleSection
        group={group({ schedule: schedule() })}
        promptText="Hello"
        canEdit={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'com_ui_schedule_run_now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_ui_schedule_remove' })).toBeNull();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('com_ui_schedule_last_run')).toBeInTheDocument();
  });
});
