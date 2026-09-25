import { describe, expect, test } from "@jest/globals";
import { priceOptionPackage } from "../dist/package-pricing.js";

const NOW = "2026-09-24T20:00:00.000Z";
const EXPIRATION = "2026-10-16T20:00:00.000Z";

function leg(symbol, action, bid, ask, asOf = NOW, expiration = EXPIRATION) {
  return {
    symbol,
    action,
    quantity: 1,
    expiration,
    bid,
    ask,
    as_of: asOf,
    source: "fixture",
  };
}

describe("package pricing regression", () => {
  test("prices a debit vertical with separate native and synthetic evidence", () => {
    const result = priceOptionPackage({
      family: "DEBIT_VERTICAL",
      evaluated_at: NOW,
      legs: [
        leg("SPX-C1", "BUY_TO_OPEN", "4.9", "5.1"),
        leg("SPX-C2", "SELL_TO_OPEN", "2.0", "2.2"),
      ],
      native_package: {
        bid: "2.8",
        ask: "3.0",
        price_effect: "DEBIT",
        as_of: NOW,
        source: "native-complex-book",
      },
    });

    expect(result.quote_type).toBe("NATIVE_PACKAGE");
    expect(result.package_mid).toBe("2.9");
    expect(result.synthetic_natural).toMatchObject({
      value: "3.1",
      price_effect: "DEBIT",
      evidence_type: "SYNTHETIC_NATURAL",
      guaranteed_executable: false,
    });
    expect(result.synthetic_mid).toMatchObject({
      value: "2.9",
      evidence_type: "SYNTHETIC_MID_REFERENCE",
      guaranteed_executable: false,
    });
  });

  test("prices a credit vertical", () => {
    const result = priceOptionPackage({
      family: "CREDIT_VERTICAL",
      evaluated_at: NOW,
      legs: [
        leg("SPX-P1", "SELL_TO_OPEN", "3.0", "3.2"),
        leg("SPX-P2", "BUY_TO_OPEN", "1.0", "1.2"),
      ],
    });

    expect(result.quote_type).toBe("SYNTHETIC_NATURAL");
    expect(result.synthetic_natural).toMatchObject({
      value: "1.8",
      price_effect: "CREDIT",
    });
  });

  test("prices a four-leg iron condor", () => {
    const result = priceOptionPackage({
      family: "IRON_CONDOR",
      evaluated_at: NOW,
      legs: [
        leg("SPX-P-LONG", "BUY_TO_OPEN", "0.9", "1.0"),
        leg("SPX-P-SHORT", "SELL_TO_OPEN", "2.0", "2.1"),
        leg("SPX-C-SHORT", "SELL_TO_OPEN", "2.1", "2.2"),
        leg("SPX-C-LONG", "BUY_TO_OPEN", "1.0", "1.1"),
      ],
    });

    expect(result.synthetic_natural).toMatchObject({
      value: "2",
      price_effect: "CREDIT",
    });
  });

  test("prices a multi-expiration double diagonal", () => {
    const near = "2026-10-02T20:00:00.000Z";
    const far = "2026-10-30T20:00:00.000Z";
    const result = priceOptionPackage({
      family: "DOUBLE_DIAGONAL",
      evaluated_at: NOW,
      legs: [
        leg("SPX-P-NEAR", "SELL_TO_OPEN", "3", "3.2", NOW, near),
        leg("SPX-C-NEAR", "SELL_TO_OPEN", "2.8", "3", NOW, near),
        leg("SPX-P-FAR", "BUY_TO_OPEN", "4", "4.2", NOW, far),
        leg("SPX-C-FAR", "BUY_TO_OPEN", "3.8", "4", NOW, far),
      ],
    });

    expect(result.synthetic_natural).toMatchObject({
      value: "2.4",
      price_effect: "DEBIT",
    });
  });

  test.each([
    {
      name: "stale",
      legs: [
        leg(
          "SPX-C1",
          "BUY_TO_OPEN",
          "4.9",
          "5.1",
          "2026-09-24T19:58:00.000Z",
        ),
        leg("SPX-C2", "SELL_TO_OPEN", "2", "2.2"),
      ],
      warning: "STALE_QUOTE_SET",
    },
    {
      name: "missing",
      legs: [
        leg("SPX-C1", "BUY_TO_OPEN", "4.9", null),
        leg("SPX-C2", "SELL_TO_OPEN", "2", "2.2"),
      ],
      warning: "MISSING_LEG_QUOTE:SPX-C1",
    },
    {
      name: "crossed",
      legs: [
        leg("SPX-C1", "BUY_TO_OPEN", "5.2", "5.1"),
        leg("SPX-C2", "SELL_TO_OPEN", "2", "2.2"),
      ],
      warning: "CROSSED_LEG_MARKET:SPX-C1",
    },
    {
      name: "timestamp mismatch",
      legs: [
        leg(
          "SPX-C1",
          "BUY_TO_OPEN",
          "4.9",
          "5.1",
          "2026-09-24T19:59:50.000Z",
        ),
        leg(
          "SPX-C2",
          "SELL_TO_OPEN",
          "2",
          "2.2",
          "2026-09-24T19:59:59.000Z",
        ),
      ],
      warning: "TEMPORAL_MISALIGNMENT:9000ms",
    },
    {
      name: "future timestamp",
      legs: [
        leg(
          "SPX-C1",
          "BUY_TO_OPEN",
          "4.9",
          "5.1",
          "2026-09-24T20:01:00.000Z",
        ),
        leg(
          "SPX-C2",
          "SELL_TO_OPEN",
          "2",
          "2.2",
          "2026-09-24T20:01:00.000Z",
        ),
      ],
      warning: "FUTURE_QUOTE_TIMESTAMP",
    },
    {
      name: "missing timestamp",
      legs: [
        leg("SPX-C1", "BUY_TO_OPEN", "4.9", "5.1", null),
        leg("SPX-C2", "SELL_TO_OPEN", "2", "2.2"),
      ],
      warning: "MISSING_LEG_TIMESTAMP:SPX-C1",
    },
  ])("flags $name quote evidence", ({ legs, warning }) => {
    const result = priceOptionPackage({
      family: "DEBIT_VERTICAL",
      evaluated_at: NOW,
      max_quote_age_ms: 30_000,
      max_temporal_skew_ms: 2_000,
      legs,
    });

    expect(result.warnings).toContain(warning);
    expect(result.usable_for_execution).toBe(false);
  });

  test("rejects unknown leg actions instead of treating them as sells", () => {
    expect(() =>
      priceOptionPackage({
        family: "DEBIT_VERTICAL",
        evaluated_at: NOW,
        legs: [
          leg("SPX-C1", "NOT_AN_ACTION", "4.9", "5.1"),
          leg("SPX-C2", "SELL_TO_OPEN", "2", "2.2"),
        ],
      }),
    ).toThrow("Unsupported leg action");
  });
});
