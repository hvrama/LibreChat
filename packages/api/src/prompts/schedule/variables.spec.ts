import { renderPromptText, UnresolvedPromptVariablesError } from './variables';

describe('renderPromptText', () => {
  const now = new Date('2026-09-13T15:30:00Z');

  it('substitutes special and user variables', () => {
    const rendered = renderPromptText({
      text: 'Hi {{current_user}}, report for {{ region }} on {{current_date}}.',
      variables: { region: 'EMEA' },
      user: { name: 'Ada' },
      timezone: 'UTC',
      now,
    });
    expect(rendered).toBe('Hi Ada, report for EMEA on 2026-09-13 (Sunday).');
  });

  it('throws listing every unresolved placeholder once', () => {
    expect.assertions(2);
    try {
      renderPromptText({
        text: '{{a}} and {{ b }} and {{a}}',
        variables: {},
        now,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(UnresolvedPromptVariablesError);
      expect((error as UnresolvedPromptVariablesError).variables).toEqual(['a', 'b']);
    }
  });

  it('leaves text without placeholders untouched', () => {
    expect(renderPromptText({ text: 'plain text', now })).toBe('plain text');
  });
});
