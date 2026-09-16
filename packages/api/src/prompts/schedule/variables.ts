import { replaceSpecialVars } from 'librechat-data-provider';
import type { TUser } from 'librechat-data-provider';

const VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

export class UnresolvedPromptVariablesError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Unresolved prompt variables: ${variables.join(', ')}`);
    this.name = 'UnresolvedPromptVariablesError';
    this.variables = variables;
  }
}

export type RenderPromptTextParams = {
  text: string;
  variables?: Record<string, string>;
  user?: Pick<TUser, 'name'> | null;
  timezone?: string;
  now?: Date;
};

/**
 * Substitutes special variables (`current_date`, `current_user`, ...) and the schedule's
 * saved user variables. Throws when any `{{placeholder}}` remains unresolved so a
 * scheduled run never sends a raw template to the model.
 */
export function renderPromptText({
  text,
  variables = {},
  user,
  timezone,
  now,
}: RenderPromptTextParams): string {
  const withSpecialVars = replaceSpecialVars({
    text,
    user: user as TUser | null | undefined,
    timezone,
    now,
  });
  const unresolved = new Set<string>();
  const rendered = withSpecialVars.replace(VARIABLE_PATTERN, (match: string, rawName: string) => {
    const name = rawName.trim();
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return variables[name];
    }
    unresolved.add(name);
    return match;
  });
  if (unresolved.size > 0) {
    throw new UnresolvedPromptVariablesError([...unresolved]);
  }
  return rendered;
}
