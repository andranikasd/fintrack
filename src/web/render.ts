import template from './dashboard.html';
import type { DashboardData } from './data';
import { buildGoalModel } from './goal-model';

export function renderDashboard(data: DashboardData | null, live: boolean): string {
  const json = JSON.stringify({live,data}).replace(/[<>&\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  return template.replace('__FINTRACK_DATA__',()=>json).replace('__FINTRACK_GOAL_MODEL__',()=>buildGoalModel.toString());
}
