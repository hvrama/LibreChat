import { useMemo, useState } from 'react';
import { EModelEndpoint, PromptSchedulePreset } from 'librechat-data-provider';
import { Button, Input, Label, Switch, Dropdown, ControlCombobox } from '@librechat/client';
import type {
  Agent,
  TMessage,
  TPromptGroupSchedule,
  TPromptGroupScheduleInput,
} from 'librechat-data-provider';
import type { OptionWithIcon } from '~/common';
import type { ScheduleFormState, ScheduleFormErrors } from './utils';
import MessageIcon from '~/components/Share/MessageIcon';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import {
  toFormState,
  toScheduleInput,
  listTimezones,
  validateFormState,
  getUserVariables,
  getBrowserTimezone,
} from './utils';

const FREQUENCIES = [
  { value: PromptSchedulePreset.daily, key: 'com_ui_schedule_daily' },
  { value: PromptSchedulePreset.weekdays, key: 'com_ui_schedule_weekdays' },
  { value: PromptSchedulePreset.weekly, key: 'com_ui_schedule_weekly' },
  { value: PromptSchedulePreset.monthly, key: 'com_ui_schedule_monthly' },
  { value: 'custom', key: 'com_ui_schedule_custom_cron' },
] as const;

const AGENT_MESSAGE = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  label: String(i + 1),
  value: String(i + 1),
}));

function weekdayOptions(): { label: string; value: string }[] {
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, day) => ({
    label: formatter.format(new Date(Date.UTC(2024, 0, 7 + day, 12))),
    value: String(day),
  }));
}

interface ScheduleFormProps {
  schedule?: TPromptGroupSchedule | null;
  promptText: string;
  minIntervalMinutes: number;
  isSubmitting: boolean;
  onSubmit: (input: TPromptGroupScheduleInput) => void;
  onCancel?: () => void;
}

export default function ScheduleForm({
  schedule,
  promptText,
  minIntervalMinutes,
  isSubmitting,
  onSubmit,
  onCancel,
}: ScheduleFormProps) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [state, setState] = useState<ScheduleFormState>(() =>
    toFormState(schedule?.source, {
      agentId: schedule?.agent_id ?? '',
      timezone: schedule?.timezone ?? getBrowserTimezone(),
      variables: schedule?.variables ?? {},
      notifyEmail: schedule?.notify?.email ?? false,
    }),
  );

  const agentOptions = useMemo<OptionWithIcon[]>(
    () =>
      Object.values(agentsMap ?? {})
        .filter((agent): agent is Agent => !!agent?.id)
        .map((agent) => ({
          label: agent.name ?? agent.id,
          value: agent.id,
          icon: <MessageIcon message={AGENT_MESSAGE} agent={agent} />,
        })),
    [agentsMap],
  );
  const timezoneOptions = useMemo(
    () => listTimezones(state.timezone).map((zone) => ({ label: zone, value: zone })),
    [state.timezone],
  );
  const weekdays = useMemo(weekdayOptions, []);
  const variableNames = useMemo(() => getUserVariables(promptText), [promptText]);

  const patch = (update: Partial<ScheduleFormState>) =>
    setState((prev) => ({ ...prev, ...update }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const nextErrors = validateFormState(state);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    onSubmit(toScheduleInput(state));
  };

  const frequencyOptions = FREQUENCIES.map(({ value, key }) => ({ value, label: localize(key) }));
  const isCustom = state.frequency === 'custom';

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 px-4 pb-4"
      aria-label={localize('com_ui_schedule')}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="schedule-agent">{localize('com_ui_agent')}</Label>
        <ControlCombobox
          isCollapsed={false}
          ariaLabel={localize('com_ui_agent')}
          selectedValue={state.agentId}
          displayValue={agentsMap?.[state.agentId]?.name ?? ''}
          setValue={(value) => patch({ agentId: value })}
          selectPlaceholder={localize('com_ui_schedule_agent_placeholder')}
          searchPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_search') })}
          items={agentOptions}
          className="h-9 w-full"
          containerClassName="px-0"
        />
        {errors.agentId && (
          <p className="text-xs text-red-500" role="alert">
            {localize(errors.agentId)}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="schedule-frequency">{localize('com_ui_schedule_frequency')}</Label>
          <Dropdown
            value={state.frequency}
            onChange={(value) => patch({ frequency: value as ScheduleFormState['frequency'] })}
            options={frequencyOptions}
            ariaLabel={localize('com_ui_schedule_frequency')}
            className="w-full"
            testId="schedule-frequency"
          />
        </div>

        {isCustom ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-cron">{localize('com_ui_schedule_custom_cron')}</Label>
            <Input
              id="schedule-cron"
              value={state.cron}
              placeholder="0 9 * * 1-5"
              onChange={(e) => patch({ cron: e.target.value })}
              aria-invalid={!!errors.cron}
            />
            {errors.cron && (
              <p className="text-xs text-red-500" role="alert">
                {localize(errors.cron)}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-time">{localize('com_ui_schedule_time')}</Label>
            <Input
              id="schedule-time"
              type="time"
              value={state.time}
              onChange={(e) => patch({ time: e.target.value })}
              aria-invalid={!!errors.time}
            />
            {errors.time && (
              <p className="text-xs text-red-500" role="alert">
                {localize(errors.time)}
              </p>
            )}
          </div>
        )}

        {state.frequency === PromptSchedulePreset.weekly && (
          <div className="flex flex-col gap-1">
            <Label>{localize('com_ui_schedule_day_of_week')}</Label>
            <Dropdown
              value={String(state.dayOfWeek)}
              onChange={(value) => patch({ dayOfWeek: Number(value) })}
              options={weekdays}
              ariaLabel={localize('com_ui_schedule_day_of_week')}
              className="w-full"
              testId="schedule-day-of-week"
            />
          </div>
        )}

        {state.frequency === PromptSchedulePreset.monthly && (
          <div className="flex flex-col gap-1">
            <Label>{localize('com_ui_schedule_day_of_month')}</Label>
            <Dropdown
              value={String(state.dayOfMonth)}
              onChange={(value) => patch({ dayOfMonth: Number(value) })}
              options={DAYS_OF_MONTH}
              ariaLabel={localize('com_ui_schedule_day_of_month')}
              className="w-full"
              testId="schedule-day-of-month"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Label>{localize('com_ui_schedule_timezone')}</Label>
          <ControlCombobox
            isCollapsed={false}
            ariaLabel={localize('com_ui_schedule_timezone')}
            selectedValue={state.timezone}
            displayValue={state.timezone}
            setValue={(value) => patch({ timezone: value })}
            selectPlaceholder={localize('com_ui_schedule_timezone')}
            searchPlaceholder={localize('com_ui_search')}
            items={timezoneOptions}
            className="h-9 w-full"
            containerClassName="px-0"
          />
        </div>
      </div>

      <p className="text-xs text-text-secondary">
        {localize('com_ui_schedule_min_interval', { 0: String(minIntervalMinutes) })}
      </p>

      {variableNames.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-primary">
            {localize('com_ui_schedule_variables')}
          </legend>
          <p className="text-xs text-text-secondary">
            {localize('com_ui_schedule_variables_hint')}
          </p>
          {variableNames.map((name) => (
            <div key={name} className="flex flex-col gap-1">
              <Label htmlFor={`schedule-var-${name}`}>{name}</Label>
              <Input
                id={`schedule-var-${name}`}
                value={state.variables[name] ?? ''}
                onChange={(e) =>
                  patch({ variables: { ...state.variables, [name]: e.target.value } })
                }
              />
            </div>
          ))}
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="schedule-notify-email"
          checked={state.notifyEmail}
          onCheckedChange={(checked) => patch({ notifyEmail: checked })}
          aria-label={localize('com_ui_schedule_notify_email')}
        />
        <Label htmlFor="schedule-notify-email" className="text-sm text-text-secondary">
          {localize('com_ui_schedule_notify_email')}
        </Label>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {localize('com_ui_cancel')}
          </Button>
        )}
        <Button type="submit" variant="submit" size="sm" disabled={isSubmitting}>
          {localize('com_ui_schedule_save')}
        </Button>
      </div>
    </form>
  );
}
