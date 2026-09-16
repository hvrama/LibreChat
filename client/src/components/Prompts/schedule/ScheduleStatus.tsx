import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, ChevronDown, ChevronRight } from 'lucide-react';
import { PromptScheduleRunStatus } from 'librechat-data-provider';
import { Button, useToastContext } from '@librechat/client';
import type { TPromptGroupSchedule, TPromptScheduleRun } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  useRunPromptGroupSchedule,
  useGetPromptGroupScheduleRuns,
  useGetPromptGroupScheduleRecipients,
} from '~/data-provider';
import { getResponseError, isConflictError } from './utils';
import { formatDateTime } from '~/utils';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const STATUS_STYLES: Record<PromptScheduleRunStatus, { key: TranslationKeys; className: string }> =
  {
    [PromptScheduleRunStatus.succeeded]: {
      key: 'com_ui_schedule_status_succeeded',
      className: 'bg-green-500/15 text-green-600 dark:text-green-400',
    },
    [PromptScheduleRunStatus.failed]: {
      key: 'com_ui_schedule_status_failed',
      className: 'bg-red-500/15 text-red-600 dark:text-red-400',
    },
    [PromptScheduleRunStatus.skipped]: {
      key: 'com_ui_schedule_status_skipped',
      className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
    },
  };

function StatusBadge({ status }: { status: PromptScheduleRunStatus }) {
  const localize = useLocalize();
  const style = STATUS_STYLES[status];
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', style.className)}>
      {localize(style.key)}
    </span>
  );
}

function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
      >
        {open ? <ChevronDown className="icon-sm" /> : <ChevronRight className="icon-sm" />}
        {label}
      </button>
      {open && children}
    </div>
  );
}

function RunRow({ run }: { run: TPromptScheduleRun }) {
  const localize = useLocalize();
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border-light p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} />
        <span className="text-text-secondary">{formatDateTime(run.startedAt)}</span>
        {run.conversationId && (
          <Link to={`/c/${run.conversationId}`} className="text-sm underline">
            {localize('com_ui_schedule_open_conversation')}
          </Link>
        )}
      </div>
      {run.errorMessage && <p className="text-xs text-red-500">{run.errorMessage}</p>}
      {run.warnings?.length > 0 && (
        <ul className="text-xs text-text-secondary">
          {run.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ScheduleStatusProps {
  groupId: string;
  schedule: TPromptGroupSchedule;
  canEdit: boolean;
}

export default function ScheduleStatus({ groupId, schedule, canEdit }: ScheduleStatusProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [showRuns, setShowRuns] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);

  const runsQuery = useGetPromptGroupScheduleRuns(groupId, { enabled: showRuns });
  const recipientsQuery = useGetPromptGroupScheduleRecipients(groupId, {
    enabled: showRecipients,
  });
  const runNow = useRunPromptGroupSchedule({
    onSuccess: () =>
      showToast({ status: 'success', message: localize('com_ui_schedule_run_queued') }),
    onError: (error) =>
      showToast({
        status: 'error',
        message: isConflictError(error)
          ? localize('com_ui_schedule_running')
          : getResponseError(error, localize('com_ui_schedule_error')),
      }),
  });

  const never = localize('com_ui_schedule_never');

  return (
    <div className="flex flex-col gap-3 px-4 pb-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-text-secondary">{localize('com_ui_schedule_last_run')}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {schedule.lastRunStatus && <StatusBadge status={schedule.lastRunStatus} />}
          <span>{schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : never}</span>
          {schedule.lastConversationId && (
            <Link to={`/c/${schedule.lastConversationId}`} className="underline">
              {localize('com_ui_schedule_open_conversation')}
            </Link>
          )}
        </dd>
        {schedule.lastError && (
          <>
            <dt className="text-text-secondary">{localize('com_ui_error')}</dt>
            <dd className="text-red-500">{schedule.lastError}</dd>
          </>
        )}
        <dt className="text-text-secondary">{localize('com_ui_schedule_next_run')}</dt>
        <dd>
          {schedule.enabled && schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : never}
        </dd>
      </dl>

      {canEdit && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runNow.isLoading}
            onClick={() => runNow.mutate(groupId)}
          >
            <Play className="icon-sm" aria-hidden="true" />
            {localize('com_ui_schedule_run_now')}
          </Button>
        </div>
      )}

      <Disclosure
        label={localize('com_ui_schedule_runs')}
        open={showRuns}
        onToggle={() => setShowRuns((v) => !v)}
      >
        {runsQuery.data && runsQuery.data.length === 0 && (
          <p className="text-text-secondary">{localize('com_ui_schedule_no_runs')}</p>
        )}
        {runsQuery.data && runsQuery.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {runsQuery.data.map((run) => (
              <RunRow key={run._id} run={run} />
            ))}
          </ul>
        )}
      </Disclosure>

      {schedule.notify?.email && canEdit && (
        <Disclosure
          label={localize('com_ui_schedule_recipients')}
          open={showRecipients}
          onToggle={() => setShowRecipients((v) => !v)}
        >
          {recipientsQuery.data && (
            <div className="flex flex-col gap-1">
              {recipientsQuery.data.recipients.length === 0 ? (
                <p className="text-text-secondary">{localize('com_ui_schedule_no_recipients')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {recipientsQuery.data.recipients.map((recipient) => (
                    <li key={recipient.userId}>
                      {recipient.name}
                      {recipient.email && (
                        <span className="text-text-secondary"> · {recipient.email}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {recipientsQuery.data.skipped.length > 0 && (
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_schedule_recipients_skipped')}
                </p>
              )}
              {recipientsQuery.data.capped && (
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_schedule_recipients_capped')}
                </p>
              )}
            </div>
          )}
        </Disclosure>
      )}
    </div>
  );
}
