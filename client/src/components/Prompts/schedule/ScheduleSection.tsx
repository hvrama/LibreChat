import { useState } from 'react';
import { CalendarClock, Pencil, Trash2 } from 'lucide-react';
import { Button, Switch, useToastContext } from '@librechat/client';
import type { TPromptGroup, TPromptGroupScheduleInput } from 'librechat-data-provider';
import {
  useGetStartupConfig,
  useUpdatePromptGroup,
  useClearPromptGroupSchedule,
} from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';
import ScheduleStatus from './ScheduleStatus';
import { getResponseError } from './utils';
import ScheduleForm from './ScheduleForm';
import { useLocalize } from '~/hooks';

interface ScheduleSectionProps {
  group: TPromptGroup;
  promptText: string;
  canEdit: boolean;
}

export default function ScheduleSection({ group, promptText, canEdit }: ScheduleSectionProps) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const { showToast } = useToastContext();
  const { data: startupConfig } = useGetStartupConfig();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const scheduling = startupConfig?.scheduledPrompts;
  const groupId = group._id ?? '';
  const schedule = group.schedule ?? null;

  const updateGroup = useUpdatePromptGroup({
    onSuccess: () => {
      setIsEditing(false);
      showToast({ status: 'success', message: localize('com_ui_schedule_saved') });
    },
    onError: (error) =>
      showToast({
        status: 'error',
        message: getResponseError(error, localize('com_ui_schedule_error')),
      }),
  });
  const clearSchedule = useClearPromptGroupSchedule({
    onSuccess: () => {
      setConfirmRemove(false);
      showToast({ status: 'success', message: localize('com_ui_schedule_removed') });
    },
    onError: (error) =>
      showToast({
        status: 'error',
        message: getResponseError(error, localize('com_ui_schedule_error')),
      }),
  });

  if (!scheduling?.enabled || !groupId) {
    return null;
  }
  if (!schedule && !canEdit) {
    return null;
  }

  const saveSchedule = (input: TPromptGroupScheduleInput) =>
    updateGroup.mutate({ id: groupId, payload: { schedule: input } });
  const toggleEnabled = (enabled: boolean) =>
    updateGroup.mutate({ id: groupId, payload: { schedule: { enabled } } });

  const agentName = schedule ? (agentsMap?.[schedule.agent_id]?.name ?? schedule.agent_id) : '';
  const showForm = canEdit && (isEditing || !schedule);

  return (
    <section
      className="rounded-xl border border-border-medium"
      aria-label={localize('com_ui_schedule')}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-2 px-4 py-2 text-sm text-text-secondary">
        <CalendarClock className="icon-sm shrink-0" aria-hidden="true" />
        <span className="font-medium text-text-primary">{localize('com_ui_schedule')}</span>
        {schedule && (
          <span className="truncate">
            {agentName} · {schedule.cron} · {schedule.timezone}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {schedule && (
            <Switch
              checked={schedule.enabled}
              onCheckedChange={toggleEnabled}
              disabled={!canEdit || updateGroup.isLoading}
              aria-label={localize('com_ui_schedule_enabled')}
            />
          )}
          {schedule && canEdit && !isEditing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIsEditing(true)}
              aria-label={localize('com_ui_edit')}
            >
              <Pencil className="icon-sm" aria-hidden="true" />
            </Button>
          )}
          {schedule && canEdit && !confirmRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(true)}
              aria-label={localize('com_ui_schedule_remove')}
            >
              <Trash2 className="icon-sm" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {confirmRemove && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-sm">
          <span>{localize('com_ui_schedule_remove_confirm')}</span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={clearSchedule.isLoading}
            onClick={() => clearSchedule.mutate(groupId)}
          >
            {localize('com_ui_schedule_remove')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
            {localize('com_ui_cancel')}
          </Button>
        </div>
      )}

      {showForm ? (
        <ScheduleForm
          key={schedule ? 'edit' : 'create'}
          schedule={schedule}
          promptText={promptText}
          minIntervalMinutes={scheduling.minIntervalMinutes}
          isSubmitting={updateGroup.isLoading}
          onSubmit={saveSchedule}
          onCancel={schedule ? () => setIsEditing(false) : undefined}
        />
      ) : (
        schedule && <ScheduleStatus groupId={groupId} schedule={schedule} canEdit={canEdit} />
      )}
    </section>
  );
}
