import { describe, expect, jest, test } from "@jest/globals";
import {
  TastytradeLiveOptionSnapshotClient,
  mergeLiveOptionEvents,
  parseDxlinkLiveOptionData,
} from "../dist/live-option-snapshot.js";

const NOW = Date.parse("2026-09-29T02:45:00.000Z");
const EXPIRATION = "2026-09-29";
const CALL_SYMBOL = ".SPXW260929C100";
const PUT_SYMBOL = ".SPXW260929P100";

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  closeCalls = [];

  constructor(batches) {
    this.batches = batches;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data) {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === "SETUP") {
        this.emit({
          type: "AUTH_STATE",
          channel: 0,
          state: "UNAUTHORIZED",
        });
      } else if (message.type === "AUTH") {
        this.emit({
          type: "AUTH_STATE",
          channel: 0,
          state: "AUTHORIZED",
        });
      } else if (message.type === "CHANNEL_REQUEST") {
        this.emit({
          type: "CHANNEL_OPENED",
          channel: 3,
          service: "FEED",
        });
      } else if (message.type === "FEED_SETUP") {
        this.emit({
          type: "FEED_CONFIG",
          channel: 3,
          aggregationPeriod: 0.1,
          dataFormat: "COMPACT",
        });
      } else if (
        message.type === "FEED_SUBSCRIPTION" &&
        message.add
      ) {
        for (const data of this.batches) {
          this.emit({ type: "FEED_DATA", channel: 3, data });
        }
      }
    });
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

function chainResponse() {
  return {
    data: {
      items: [
        {
          "underlying-symbol": "SPX",
          "root-symbol": "SPX",
          "shares-per-contract": 100,
          expirations: [
            {
              "expiration-date": EXPIRATION,
              "days-to-expiration": 1,
              "settlement-type": "AM",
              strikes: [
                {
                  "strike-price": "100",
                  call: "SPX   260929C00100000",
                  "call-streamer-symbol": ".SPX260929C100",
                  put: "SPX   260929P00100000",
                  "put-streamer-symbol": ".SPX260929P100",
                },
              ],
            },
          ],
        },
        {
          "underlying-symbol": "SPX",
          "root-symbol": "SPXW",
          "shares-per-contract": 100,
          expirations: [
            {
              "expiration-date": EXPIRATION,
              "days-to-expiration": 1,
              "settlement-type": "PM",
              strikes: [
                {
                  "strike-price": "95",
                  call: "SPXW  260929C00095000",
                  "call-streamer-symbol": ".SPXW260929C95",
                  put: "SPXW  260929P00095000",
                  "put-streamer-symbol": ".SPXW260929P95",
                },
                {
                  "strike-price": "100",
                  call: "SPXW  260929C00100000",
                  "call-streamer-symbol": CALL_SYMBOL,
                  put: "SPXW  260929P00100000",
                  "put-streamer-symbol": PUT_SYMBOL,
                },
                {
                  "strike-price": "105",
                  call: "SPXW  260929C00105000",
                  "call-streamer-symbol": ".SPXW260929C105",
                  put: "SPXW  260929P00105000",
                  "put-streamer-symbol": ".SPXW260929P105",
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function liveBatches({
  callOpenInterest = 10,
  putOpenInterest = 5,
  greeksTime = NOW,
  quoteTime = NOW,
  summaryTime = NOW,
} = {}) {
  return [
    [
      "Summary",
      [
        "Summary",
        CALL_SYMBOL,
        summaryTime,
        callOpenInterest,
        "Summary",
        PUT_SYMBOL,
        summaryTime,
        putOpenInterest,
      ],
    ],
    [
      "Quote",
      [
        "Quote",
        CALL_SYMBOL,
        quoteTime,
        quoteTime,
        2,
        2.2,
        10,
        12,
        "Quote",
        PUT_SYMBOL,
        quoteTime,
        quoteTime,
        1.8,
        2,
        8,
        9,
      ],
    ],
    [
      "Greeks",
      [
        "Greeks",
        CALL_SYMBOL,
        0,
        1,
        greeksTime,
        0,
        2.1,
        0.2,
        0.5,
        0.01,
        -1,
        0.1,
        1.2,
        "Greeks",
        PUT_SYMBOL,
        0,
        1,
        greeksTime,
        0,
        1.9,
        0.2,
        -0.5,
        0.02,
        -1,
        -0.1,
        1.2,
      ],
    ],
  ];
}

function fixture(options = {}) {
  let socket;
  const http = {
    get: jest.fn(async (path) => {
      if (path !== "/option-chains/SPX/nested") {
        throw new Error(`Unexpected HTTP path ${path}`);
      }
      return { data: chainResponse() };
    }),
  };
  const client = new TastytradeLiveOptionSnapshotClient({
    oauth: { getAccessToken: async () => "access-token" },
    http,
    quoteTokens: {
      getQuoteToken: async () => ({
        token: "quote-token",
        url: "wss://tasty-openapi-ws.dxfeed.com/realtime",
      }),
    },
    socketFactory: () => {
      socket = new FakeSocket(liveBatches(options));
      return socket;
    },
    clock: () => NOW,
  });
  return { client, http, getSocket: () => socket };
}

describe("unified live option snapshot", () => {
  test("merges Summary.openInterest by exact streamer symbol without zero fill", () => {
    const states = new Map([
      [
        CALL_SYMBOL,
        {
          quote: null,
          greeks: null,
          summary: null,
        },
      ],
    ]);
    const events = parseDxlinkLiveOptionData(
      [
        "Summary",
        [
          "Summary",
          CALL_SYMBOL,
          0,
          66,
          "Summary",
          ".SPXW260929C105",
          0,
          99,
        ],
      ],
      NOW,
    );

    expect(mergeLiveOptionEvents(states, events)).toEqual([
      ".SPXW260929C105",
    ]);
    expect(states.get(CALL_SYMBOL).summary).toMatchObject({
      symbol: CALL_SYMBOL,
      openInterest: "66",
      eventTimeMs: null,
      receivedAtMs: NOW,
    });

    const missing = parseDxlinkLiveOptionData(
      ["Summary", ["Summary", CALL_SYMBOL, 0, "NaN"]],
      NOW,
    );
    mergeLiveOptionEvents(states, missing);
    expect(states.get(CALL_SYMBOL).summary.openInterest).toBeNull();

    const invalidNegative = parseDxlinkLiveOptionData(
      ["Summary", ["Summary", CALL_SYMBOL, 0, -1]],
      NOW,
    );
    mergeLiveOptionEvents(states, invalidNegative);
    expect(states.get(CALL_SYMBOL).summary.openInterest).toBeNull();
  });

  test("integrates SPXW chain identity with Quote, Greeks, Summary, and gamma concentration", async () => {
    const { client, http, getSocket } = fixture();

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPXW",
      expirations: [EXPIRATION],
      around_price: "100",
      strike_count: 1,
      include_quotes: true,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
      deadline_ms: 1000,
      max_temporal_skew_ms: 1000,
    });

    expect(http.get).toHaveBeenCalledWith(
      "/option-chains/SPX/nested",
      expect.objectContaining({
        headers: { Authorization: "Bearer access-token" },
      }),
    );
    expect(result).toMatchObject({
      status: "AVAILABLE",
      underlying: "SPXW",
      canonical_chain_underlying: "SPX",
      underlying_price: "100",
      phase: "LIVE_SUPPORT",
      evidence_role: "SUPPORTING_EVIDENCE",
      research_only: true,
      production_gate_eligible: false,
      snapshot_complete: true,
      quote_complete: true,
      greeks_complete: true,
      summary_complete: true,
      temporal_alignment: {
        status: "ALIGNED",
        aligned_contracts: 2,
      },
      data_completeness: {
        selected_contracts: 2,
        summary: {
          open_interest_available_contracts: 2,
          complete: true,
        },
      },
      gamma_concentration_proxy: {
        methodology: "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
        status: "AVAILABLE",
        total_concentration: "2000",
        gamma_risk: "UNKNOWN",
        dealer_gex_status: "UNKNOWN",
        evidence_role: "SUPPORTING_EVIDENCE",
        production_gate_eligible: false,
        near_spot_concentration: {
          concentration: "2000",
          contract_count: 2,
          share_of_total: "1",
        },
        data_completeness: {
          total_contracts: 2,
          eligible_contracts: 2,
          missing_open_interest: 0,
          coverage_ratio: "1",
        },
      },
      market_data_handoff: {
        gamma_concentration_proxy: "2000",
        gamma_proxy_methodology:
          "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
        gamma_proxy_completeness: {
          status: "AVAILABLE",
          coverage_ratio: "1",
          snapshot_complete: true,
          temporal_alignment: "ALIGNED",
        },
        dealer_gex_status: "UNKNOWN",
        evidence_role: "SUPPORTING_EVIDENCE",
        phase: "LIVE_SUPPORT",
      },
    });
    expect(result.contracts).toEqual([
      expect.objectContaining({
        provider_symbol: "SPXW  260929C00100000",
        occ_symbol: "SPXW  260929C00100000",
        streamer_symbol: CALL_SYMBOL,
        root_symbol: "SPXW",
        strike: "100",
        option_type: "CALL",
        expiration: EXPIRATION,
        dte: 1,
        multiplier: "100",
        settlement: "PM",
        quote: expect.objectContaining({
          bid: "2",
          ask: "2.2",
          timestamp_source: "PROVIDER_SIDE_TIME",
        }),
        greeks: expect.objectContaining({
          gamma: "0.01",
          implied_volatility: "0.2",
          timestamp_source: "PROVIDER_EVENT_TIME",
        }),
        summary: expect.objectContaining({
          open_interest: "10",
          timestamp_source: "PROVIDER_EVENT_TIME",
        }),
      }),
      expect.objectContaining({
        provider_symbol: "SPXW  260929P00100000",
        streamer_symbol: PUT_SYMBOL,
        option_type: "PUT",
        greeks: expect.objectContaining({ gamma: "0.02" }),
        summary: expect.objectContaining({ open_interest: "5" }),
      }),
    ]);
    expect(
      result.gamma_concentration_proxy.semantic_boundaries,
    ).toEqual(
      expect.arrayContaining([
        "OI_BASED_GAMMA_CONCENTRATION_IS_NOT_DEALER_GEX",
        "OPEN_INTEREST_DOES_NOT_IDENTIFY_DEALER_OR_CUSTOMER_POSITIONING",
        "UNSIGNED_CONCENTRATION_DOES_NOT_ESTABLISH_GAMMA_FLIP_OR_ZERO_GAMMA",
      ]),
    );
    expect(result.regression_record).toMatchObject({
      request_id: result.request_id,
      snapshot_id: result.snapshot_id,
      methodology: "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
      evidence_role: "SUPPORTING_EVIDENCE",
    });
    const subscription = getSocket().sent.find(
      (message) =>
        message.type === "FEED_SUBSCRIPTION" && message.add,
    );
    expect(subscription.add).toEqual(
      expect.arrayContaining([
        { type: "Quote", symbol: CALL_SYMBOL },
        { type: "Greeks", symbol: CALL_SYMBOL },
        { type: "Summary", symbol: CALL_SYMBOL },
        { type: "Quote", symbol: PUT_SYMBOL },
        { type: "Greeks", symbol: PUT_SYMBOL },
        { type: "Summary", symbol: PUT_SYMBOL },
      ]),
    );
  });

  test("keeps missing open interest null and excludes it from the proxy", async () => {
    const { client } = fixture({
      callOpenInterest: "NaN",
      putOpenInterest: "NaN",
    });

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPXW",
      expirations: [EXPIRATION],
      around_price: "100",
      strike_count: 1,
      phase: "LIVE_SUPPORT",
      deadline_ms: 1000,
      max_temporal_skew_ms: 1000,
    });

    expect(result.status).toBe("PARTIAL");
    expect(result.snapshot_complete).toBe(false);
    expect(result.summary_complete).toBe(false);
    expect(
      result.contracts.every(
        (contract) => contract.summary.open_interest === null,
      ),
    ).toBe(true);
    expect(result.gamma_concentration_proxy).toMatchObject({
      status: "NOT_AVAILABLE",
      total_concentration: "0",
      data_completeness: {
        eligible_contracts: 0,
        missing_open_interest: 2,
      },
      warnings: expect.arrayContaining([
        "MISSING_OPEN_INTEREST_EXCLUDED_NOT_ZERO_FILLED",
      ]),
    });
  });

  test("keeps receive-time-only cohorts explicit and the proxy partial", async () => {
    const { client } = fixture({
      quoteTime: 0,
      summaryTime: 0,
    });

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPXW",
      expirations: [EXPIRATION],
      around_price: "100",
      strike_count: 1,
      phase: "LIVE_SUPPORT",
      deadline_ms: 1000,
      max_temporal_skew_ms: 100,
    });

    expect(result).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: true,
      temporal_alignment: {
        status: "UNVERIFIABLE",
        aligned_contracts: 0,
        unverifiable_contracts: 2,
        incomplete_contracts: 0,
      },
      gamma_concentration_proxy: {
        status: "PARTIAL",
        total_concentration: "2000",
        gamma_risk: "UNKNOWN",
        dealer_gex_status: "UNKNOWN",
        data_completeness: {
          eligible_contracts: 2,
          temporal_alignment_unverifiable: 2,
          coverage_ratio: "1",
        },
        warnings: expect.arrayContaining([
          "SOURCE_TEMPORAL_ALIGNMENT_UNVERIFIABLE_PROXY_REMAINS_PARTIAL",
        ]),
      },
      market_data_handoff: {
        gamma_concentration_proxy: "2000",
        gamma_proxy_completeness: {
          status: "PARTIAL",
          snapshot_complete: true,
          temporal_alignment: "UNVERIFIABLE",
        },
      },
      warnings: expect.arrayContaining([
        "QUOTE_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
        "SUMMARY_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
        "SOURCE_TEMPORAL_ALIGNMENT_UNVERIFIABLE",
      ]),
    });
  });

  test("fails temporal alignment closed instead of promoting a partial cohort", async () => {
    const { client } = fixture({ greeksTime: NOW - 10_000 });

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPXW",
      expirations: [EXPIRATION],
      around_price: "100",
      strike_count: 1,
      phase: "LIVE_SUPPORT",
      deadline_ms: 1000,
      max_temporal_skew_ms: 100,
    });

    expect(result).toMatchObject({
      status: "PARTIAL",
      snapshot_complete: true,
      temporal_alignment: {
        status: "MISALIGNED",
        misaligned_contracts: 2,
        max_skew_ms: 10000,
      },
      gamma_concentration_proxy: {
        status: "NOT_AVAILABLE",
        dealer_gex_status: "UNKNOWN",
        data_completeness: {
          temporally_unaligned: 2,
          eligible_contracts: 0,
        },
      },
    });
  });
});
