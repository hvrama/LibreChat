import { useState, useEffect, useMemo, useCallback } from 'react';
import { Spinner, ThemeSelector } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import { useApproveUserMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

function ApproveUser() {
  const localize = useLocalize();
  const [params] = useSearchParams();

  const [headerText, setHeaderText] = useState<string>('');
  const [approvalStatus, setApprovalStatus] = useState<boolean>(false);
  const token = useMemo(() => params.get('token') || '', [params]);
  const email = useMemo(() => params.get('email') || '', [params]);

  const approveUserMutation = useApproveUserMutation({
    onSuccess: () => {
      setHeaderText(localize('com_auth_approve_success'));
      setApprovalStatus(true);
    },
    onError: () => {
      setHeaderText(localize('com_auth_approve_failed'));
      setApprovalStatus(true);
    },
  });

  useEffect(() => {
    if (approvalStatus || approveUserMutation.isLoading) {
      return;
    }

    if (token && email) {
      approveUserMutation.mutate({ email, token });
    } else {
      setHeaderText(localize('com_auth_approve_invalid'));
      setApprovalStatus(true);
    }
  }, [token, email, approvalStatus, approveUserMutation]);

  const ApprovalResult = () => (
    <div className="flex flex-col items-center justify-center">
      <h1 className="mb-4 text-center text-3xl font-semibold text-black dark:text-white">
        {headerText}
      </h1>
    </div>
  );

  const ApprovalInProgress = () => (
    <div className="flex flex-col items-center justify-center">
      <h1 className="mb-4 text-center text-3xl font-semibold text-black dark:text-white">
        {localize('com_auth_approve_in_progress')}
      </h1>
      <div className="mt-4 flex justify-center">
        <Spinner className="h-8 w-8 text-green-500" />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white pt-6 dark:bg-gray-900 sm:pt-0">
      <div className="absolute bottom-0 left-0 m-4">
        <ThemeSelector />
      </div>
      {approvalStatus ? <ApprovalResult /> : <ApprovalInProgress />}
    </div>
  );
}

export default ApproveUser;
