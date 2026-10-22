/**
 * Umbrella bundle for the meeting suite.
 *
 * This package contributes no plugin row of its own: its bundle patch inserts
 * the two plugin rows (`meeting-suite-calendar` and `meeting-suite-meeting`)
 * and declares both plugin packages as dependencies, so installing
 * `@zhangguitao666/meeting-suite` from the Add plugin field brings in the
 * meeting-minutes and task-calendar plugins together.
 */
export const name = 'meeting-suite'
export function apply() {}
