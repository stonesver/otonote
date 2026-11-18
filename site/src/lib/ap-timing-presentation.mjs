/** Use rescored benefit, including for saved plans; offsets alone are not a guide. */
export const hasApTimingInstructions = plan => Boolean(plan?.adjustments.length && plan.score > plan.onTimeMinimumScore);
