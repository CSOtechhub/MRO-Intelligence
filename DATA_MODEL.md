# Lifecycle rules

The engine is intentionally conservative. It distinguishes what a snapshot proves from what it merely omits.

## Durable identity

- `WO #` / `Number` is the durable work-order key.
- The first valid `Date` stored for that WO becomes its canonical induction date.
- If a later source supplies a different induction date, the canonical value is retained and an `INDUCTION_DATE_CONFLICT` event is recorded.
- Step, status, EDD, total price, tags, and milestone dates may change from snapshot to snapshot.

## Events

| Event | Rule |
| --- | --- |
| `NEW_WORK` | A previously unseen WO appears with an induction date later than the prior snapshot's maximum induction date. |
| `HISTORICAL_BACKFILL` | A previously unseen WO appears with an older induction date. This protects the trend line when export scope expands. |
| `REAPPEARED` | A known WO returns after not being visible in the immediately prior snapshot. |
| `STEP_CHANGED` | Step differs for the same WO in adjacent visible snapshots. |
| `STATUS_CHANGED` | Status differs for the same WO in adjacent visible snapshots. |
| `CLOSED` | A WO moves from non-terminal to `CLOSED`/`INVOICED`, or gains a Closed Date. |

A WO missing from a later file is never automatically closed or deleted.

## Forecasts

Completed cycle time is `Closed Date - induction Date`. Active forecasts use the most specific cohort with usable history:

1. part number + department;
2. part number;
3. department;
4. all completed work.

The expected date uses the cohort median and “likely by” uses P80. Confidence is high at 30+ completed observations, medium at 8–29, and low below 8. Forecasts are management decision support, not delivery commitments.

## Customer signals

Customer momentum compares inductions in the recent 90 days with the preceding 90 days. A taper requires at least five WOs in the prior period and a recent count at or below 55% of the prior count. It is a follow-up signal, not evidence that an account was lost.
