import { handleReviewCategoryName } from './category-review';
import { Composer } from 'grammy';
import type { AppContext } from '../context';
import { handleBudgetAmount } from './budget';
import { handleNewCategoryName, handleRenameCategory } from './categories';

/**
 * Multi-step flows. Runs before free-text entry, so a pending question wins
 * over expense parsing. State lives in D1 because Workers keep nothing in RAM.
 */
export const states = new Composer<AppContext>();

states.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  const current = await ctx.db.getState(ctx.userId);
  if (!current) return next();

  switch (current.state) {
    case 'review_new_category': {
      const txId = Number(current.payload['txId']);
      if (!Number.isSafeInteger(txId)) break;
      await handleReviewCategoryName(ctx, txId, text);
      return;
    }
    case 'cat_new':
      await handleNewCategoryName(ctx, text);
      return;
    case 'cat_rename': {
      const id = Number(current.payload['id']);
      if (!Number.isFinite(id)) break;
      await handleRenameCategory(ctx, id, text);
      return;
    }
    case 'budget_set': {
      const categoryId = Number(current.payload['categoryId']);
      if (!Number.isFinite(categoryId)) break;
      await handleBudgetAmount(ctx, categoryId, text);
      return;
    }
    default:
      break;
  }

  await ctx.db.clearState(ctx.userId);
  return next();
});
