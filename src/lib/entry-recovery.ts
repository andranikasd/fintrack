/** Public guidance for predictable validation failures; do not expose database internals. */
export function entryRecovery(error: unknown): { message: string; field?: string; retrySafe: boolean } {
  const text = error instanceof Error ? error.message : '';
  if (/channel update|synchronization|syncstatus|source table/i.test(text)) return {message:'The channel update could not be confirmed. Your draft is kept. Check the channel and /syncstatus before trying again.',retrySafe:false};
  if (/Insufficient funds|account balance negative/i.test(text)) return {
    message: 'Not saved: the account does not have enough money for this date. Choose another account, lower the amount, or record missing income first.',
    field: 'accountId', retrySafe: true,
  };
  if (/withdrawal exceeds|saved balance|savings balance|CHECK constraint failed: opening_minor/i.test(text)) return {
    message: 'Not saved: the withdrawal exceeds the money in this savings goal. Lower the amount or choose another goal.', field: 'amount', retrySafe: true,
  };
  if (/changed|no longer exists|stale/i.test(text)) return {
    message: 'This entry changed since you opened it. Reopen the latest entry before making a correction.', retrySafe: false,
  };
  if (/amount|whole drams|positive/i.test(text)) return { message: text, field: 'amount', retrySafe: true };
  if (/account/i.test(text)) return { message: 'Choose an active account. If you have none, add an account with its opening balance first.', field: 'accountId', retrySafe: true };
  if (/date|day/i.test(text)) return {message:'Choose today or a valid past date.',field:'day',retrySafe:true};
  if (/category/i.test(text)) return {message:'Choose an active category, or create one from Categories.',field:'categoryId',retrySafe:true};
  if (/name|label/i.test(text)) return {message:'Enter an item or source name of 1–120 characters.',field:'label',retrySafe:true};
  return {message:'Could not confirm the result. Your draft is kept. Check recent activity before retrying the same draft.',retrySafe:false};
}
