import template from './dashboard.html';
import mobileTemplate from './mobile.html';
import type { DashboardData } from './data';
import { buildGoalModel } from './goal-model';
import analyticsTemplate from './analytics.html';
import { buildAccountModel } from './account-model';
import comparisonTemplate from './comparison.html';
import { createComparisonModel } from './comparison-model';

export function renderDashboard(data: DashboardData | null, live: boolean, botUsername?: string): string {
  const json = JSON.stringify({live,data,botUsername}).replace(/[<>&\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  // Insert user data last so a label containing a template token stays literal.
  return template.replace('__FINTRACK_GOAL_MODEL__',()=>buildGoalModel.toString())
    .replace('__FINTRACK_COMPARISON__',()=>comparisonTemplate.replace('__FINTRACK_COMPARISON_MODEL__',()=>`(${createComparisonModel.toString()})`))
    .replace('__FINTRACK_ANALYTICS__',()=>analyticsTemplate.replace('__FINTRACK_ACCOUNT_MODEL__',()=>buildAccountModel.toString()))
    .replace('__FINTRACK_MOBILE__',()=>mobileTemplate)
    .replace('__FINTRACK_DATA__',()=>json);
}
