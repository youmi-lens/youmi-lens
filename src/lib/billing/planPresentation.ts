/**
 * Desktop's plan-comparison presentation reads the approved product-plan model
 * used by the public pricing surface. It deliberately does not decide access,
 * quotas, checkout eligibility, or plan codes; those remain backend-owned.
 */
// @ts-expect-error The shared website model is JavaScript and has no .d.ts.
import { FREE, PAID } from '../../../landing/app/plans.js'

export const STUDENT_BASIC_COMPARISON = [
  { metric: 'minutes', free: FREE.monthlyMinutes, studentBasic: PAID.monthlyMinutes, cadence: 'month' },
  { metric: 'recordings', free: FREE.recordingsPerDay, studentBasic: PAID.recordingsPerDay, cadence: 'day' },
  { metric: 'tasks', free: FREE.processingJobsPerDay, studentBasic: PAID.processingJobsPerDay, cadence: 'day' },
] as const
