import { describe, expect, jest, test } from "@jest/globals";
import {
  DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES,
  TastytradeLiveOptionSnapshotClient,
  chunkDxlinkSubscriptions,
  dxlinkSubscriptionFrameBytes,
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

class SubscriptionDrivenSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  closeCalls = [];

  constructor({ failOnSubscription = false, summaryTime = 0 } = {}) {
    this.failOnSubscription = failOnSubscription;
    this.summaryTime = summaryTime;
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
        if (this.failOnSubscription) {
          this.emit({
            type: "ERROR",
            channel: 3,
            error: "TEST_BATCH_FAILURE",
          });
          return;
        }
        const subscriptionsByType = new Map();
        for (const subscription of message.add) {
          const symbols =
            subscriptionsByType.get(subscription.type) ?? [];
          symbols.push(subscription.symbol);
          subscriptionsByType.set(subscription.type, symbols);
        }
        for (const [type, symbols] of subscriptionsByType) {
          const rows = [];
          for (const symbol of symbols) {
            if (type === "Quote") {
              rows.push(
                "Quote",
                symbol,
                NOW,
                NOW,
                2,
                2.2,
                10,
                12,
              );
            } else if (type === "Greeks") {
              rows.push(
                "Greeks",
                symbol,
                0,
                1,
                NOW,
                0,
                2.1,
                0.2,
                0.5,
                0.01,
                -1,
                0.1,
                1.2,
              );
            } else if (type === "Summary") {
              rows.push(
                "Summary",
                symbol,
                this.summaryTime,
                10,
              );
            }
          }
          this.emit({
            type: "FEED_DATA",
            channel: 3,
            data: [type, rows],
          });
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

function generatedChainResponse({
  expirationCount = 5,
  strikeCount = 50,
} = {}) {
  const expirations = [
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
  ].slice(0, expirationCount);
  const items = ["SPX", "SPXW"].map((root) => ({
    "underlying-symbol": "SPX",
    "root-symbol": root,
    "shares-per-contract": 100,
    expirations: expirations.map((expiration, expirationIndex) => {
      const compactExpiration = expiration.replaceAll("-", "").slice(2);
      return {
        "expiration-date": expiration,
        "days-to-expiration": expirationIndex + 1,
        "settlement-type": root === "SPX" ? "AM" : "PM",
        strikes: Array.from({ length: strikeCount }, (_, strikeIndex) => {
          const strike = 7560 + strikeIndex * 5;
          const occStrike = String(strike * 1000).padStart(8, "0");
          return {
            "strike-price": String(strike),
            call: `${root.padEnd(6)}${compactExpiration}C${occStrike}`,
            "call-streamer-symbol": `.${root}${compactExpiration}C${strike}`,
            put: `${root.padEnd(6)}${compactExpiration}P${occStrike}`,
            "put-streamer-symbol": `.${root}${compactExpiration}P${strike}`,
          };
        }),
      };
    }),
  }));
  return {
    expirations,
    response: { data: { items } },
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

function generatedFixture({
  expirationCount = 5,
  strikeCount = 50,
  maxFrameBytes,
  maxConcurrentBatches,
  failedBatchIndex = -1,
  summaryTime = 0,
} = {}) {
  const chain = generatedChainResponse({
    expirationCount,
    strikeCount,
  });
  const sockets = [];
  const client = new TastytradeLiveOptionSnapshotClient({
    oauth: { getAccessToken: async () => "access-token" },
    http: {
      get: jest.fn(async () => ({ data: chain.response })),
    },
    quoteTokens: {
      getQuoteToken: async () => ({
        token: "quote-token",
        url: "wss://tasty-openapi-ws.dxfeed.com/realtime",
      }),
    },
    socketFactory: () => {
      const socket = new SubscriptionDrivenSocket({
        failOnSubscription: sockets.length === failedBatchIndex,
        summaryTime,
      });
      sockets.push(socket);
      return socket;
    },
    clock: () => NOW,
    ...(maxFrameBytes === undefined
      ? {}
      : { maxDxlinkSubscriptionFrameBytes: maxFrameBytes }),
    ...(maxConcurrentBatches === undefined
      ? {}
      : { maxConcurrentDxlinkBatches: maxConcurrentBatches }),
  });
  return { client, sockets, expirations: chain.expirations };
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
      contract_version: "1.1.0",
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
      transport: {
        strategy: "BOUNDED_AUTO_CHUNK",
        batch_count: 1,
        complete_batches: 1,
        failed_batches: 0,
      },
      event_timestamp_alignment: {
        status: "ALIGNED",
        aligned_contracts: 2,
      },
      cohort_alignment: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
      oi_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
      greeks_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
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
        status: "COMPLETE",
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
          status: "COMPLETE",
          coverage_ratio: "1",
          snapshot_complete: true,
          temporal_alignment: "ALIGNED",
          event_timestamp_alignment: "ALIGNED",
          cohort_alignment: "CONFIRMED",
          oi_freshness: "CONFIRMED",
          greeks_freshness: "CONFIRMED",
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
      record_version: "1.1.0",
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

  test("confirms the current Gamma/OI cohort when Summary only has receive time", async () => {
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
      status: "AVAILABLE",
      snapshot_complete: true,
      event_timestamp_alignment: {
        status: "UNVERIFIABLE",
        aligned_contracts: 0,
        unverifiable_contracts: 2,
      },
      cohort_alignment: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
      oi_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
      greeks_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 2,
      },
      temporal_alignment: {
        status: "UNVERIFIABLE",
        aligned_contracts: 0,
        unverifiable_contracts: 2,
        incomplete_contracts: 0,
      },
      gamma_concentration_proxy: {
        status: "COMPLETE",
        total_concentration: "2000",
        gamma_risk: "UNKNOWN",
        dealer_gex_status: "UNKNOWN",
        data_completeness: {
          eligible_contracts: 2,
          temporal_alignment_unverifiable: 2,
          coverage_ratio: "1",
        },
        warnings: expect.arrayContaining([
          "EVENT_TIMESTAMP_ALIGNMENT_UNVERIFIABLE_NON_BLOCKING_FOR_CURRENT_COHORT",
        ]),
      },
      market_data_handoff: {
        gamma_concentration_proxy: "2000",
        gamma_proxy_completeness: {
          status: "COMPLETE",
          snapshot_complete: true,
          temporal_alignment: "UNVERIFIABLE",
          event_timestamp_alignment: "UNVERIFIABLE",
          cohort_alignment: "CONFIRMED",
          oi_freshness: "CONFIRMED",
          greeks_freshness: "CONFIRMED",
        },
      },
      warnings: expect.arrayContaining([
        "QUOTE_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
        "SUMMARY_PROVIDER_TIMESTAMP_UNAVAILABLE_USED_LOCAL_RECEIVE_TIME",
        "EVENT_TIMESTAMP_ALIGNMENT_UNVERIFIABLE",
      ]),
    });
  });

  test("records provider event-time mismatch without degrading a fresh current cohort", async () => {
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
      status: "AVAILABLE",
      snapshot_complete: true,
      event_timestamp_alignment: {
        status: "MISALIGNED",
        misaligned_contracts: 2,
        max_skew_ms: 10000,
      },
      cohort_alignment: {
        status: "CONFIRMED",
      },
      oi_freshness: {
        status: "CONFIRMED",
      },
      greeks_freshness: {
        status: "CONFIRMED",
      },
      temporal_alignment: {
        status: "MISALIGNED",
        misaligned_contracts: 2,
        max_skew_ms: 10000,
      },
      gamma_concentration_proxy: {
        status: "COMPLETE",
        total_concentration: "2000",
        dealer_gex_status: "UNKNOWN",
        data_completeness: {
          temporally_unaligned: 2,
          eligible_contracts: 2,
          coverage_ratio: "1",
        },
      },
    });
  });

  test("keeps provider-timestamp-free Greeks out of a confirmed Gamma proxy", async () => {
    const { client } = fixture({ greeksTime: 0 });

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
      cohort_alignment: {
        status: "CONFIRMED",
      },
      oi_freshness: {
        status: "CONFIRMED",
      },
      greeks_freshness: {
        status: "UNKNOWN",
        unknown_contracts: 2,
      },
      gamma_concentration_proxy: {
        status: "NOT_AVAILABLE",
        dealer_gex_status: "UNKNOWN",
        data_completeness: {
          eligible_contracts: 0,
          greeks_freshness_not_confirmed: 2,
        },
        warnings: expect.arrayContaining([
          "GREEKS_FRESHNESS_NOT_CONFIRMED",
        ]),
      },
    });
  });

  test("chunks subscriptions at the configured encoded frame boundary", () => {
    const subscriptions = [
      { type: "Greeks", symbol: ".SPXW260929C7600" },
      { type: "Summary", symbol: ".SPXW260929C7600" },
      { type: "Greeks", symbol: ".SPXW260929P7600" },
    ];
    const twoSubscriptionLimit = dxlinkSubscriptionFrameBytes(
      subscriptions.slice(0, 2),
    );

    expect(
      dxlinkSubscriptionFrameBytes(subscriptions),
    ).toBeGreaterThan(twoSubscriptionLimit);
    expect(DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES).toBeLessThan(65_536);
    const batches = chunkDxlinkSubscriptions(
      subscriptions,
      twoSubscriptionLimit,
    );

    expect(batches.map((batch) => batch.subscriptions.length)).toEqual([
      2, 1,
    ]);
    expect(
      batches.every(
        (batch) =>
          batch.frame_bytes <= twoSubscriptionLimit &&
          batch.frame_bytes ===
            dxlinkSubscriptionFrameBytes(batch.subscriptions),
      ),
    ).toBe(true);
  });

  test("auto-chunks a five-expiration SPX/SPXW snapshot without identity loss", async () => {
    const { client, sockets, expirations } = generatedFixture();

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPX",
      expirations,
      around_price: "7683.69",
      strike_count: 50,
      include_quotes: false,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
      deadline_ms: 5000,
      max_temporal_skew_ms: 1000,
    });

    expect(result).toMatchObject({
      status: "AVAILABLE",
      snapshot_complete: true,
      greeks_complete: true,
      summary_complete: true,
      transport: {
        strategy: "BOUNDED_AUTO_CHUNK",
        requested_subscriptions: 2000,
        complete_batches: result.transport.batch_count,
        partial_batches: 0,
        timed_out_batches: 0,
        failed_batches: 0,
      },
      event_timestamp_alignment: {
        status: "UNVERIFIABLE",
      },
      cohort_alignment: {
        status: "CONFIRMED",
        confirmed_contracts: 1000,
      },
      oi_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 1000,
      },
      greeks_freshness: {
        status: "CONFIRMED",
        confirmed_contracts: 1000,
      },
      data_completeness: {
        selected_contracts: 1000,
        greeks: {
          gamma_available_contracts: 1000,
        },
        summary: {
          open_interest_available_contracts: 1000,
        },
      },
      gamma_concentration_proxy: {
        status: "COMPLETE",
        data_completeness: {
          total_contracts: 1000,
          eligible_contracts: 1000,
          coverage_ratio: "1",
        },
      },
    });
    expect(result.transport.batch_count).toBeGreaterThan(1);
    expect(result.contracts).toHaveLength(1000);
    expect(
      new Set(
        result.contracts.map((contract) => contract.streamer_symbol),
      ).size,
    ).toBe(1000);
    const addFrames = sockets.flatMap((socket) =>
      socket.sent.filter(
        (message) =>
          message.type === "FEED_SUBSCRIPTION" && message.add,
      ),
    );
    expect(addFrames).toHaveLength(result.transport.batch_count);
    expect(
      addFrames.every(
        (message) =>
          Buffer.byteLength(JSON.stringify(message), "utf8") <=
          DXLINK_SAFE_SUBSCRIPTION_FRAME_BYTES,
      ),
    ).toBe(true);
  });

  test("preserves Gamma concentration across one-frame and chunked reads", async () => {
    const unchunked = generatedFixture({
      expirationCount: 1,
      strikeCount: 4,
    });
    const chunked = generatedFixture({
      expirationCount: 1,
      strikeCount: 4,
      maxFrameBytes: 512,
    });
    const request = {
      underlying: "SPX",
      expirations: unchunked.expirations,
      around_price: "7683.69",
      strike_count: 4,
      include_quotes: false,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
      deadline_ms: 5000,
      max_temporal_skew_ms: 1000,
    };

    const [oneFrameResult, chunkedResult] = await Promise.all([
      unchunked.client.getLiveOptionSnapshot(request),
      chunked.client.getLiveOptionSnapshot(request),
    ]);

    expect(oneFrameResult.transport.batch_count).toBe(1);
    expect(chunkedResult.transport.batch_count).toBeGreaterThan(1);
    expect(
      chunkedResult.gamma_concentration_proxy.total_concentration,
    ).toBe(
      oneFrameResult.gamma_concentration_proxy.total_concentration,
    );
    expect(
      chunkedResult.gamma_concentration_proxy.by_strike,
    ).toEqual(oneFrameResult.gamma_concentration_proxy.by_strike);
    expect(
      chunkedResult.contracts.map((contract) => ({
        symbol: contract.streamer_symbol,
        gamma: contract.greeks.gamma,
        open_interest: contract.summary.open_interest,
      })),
    ).toEqual(
      oneFrameResult.contracts.map((contract) => ({
        symbol: contract.streamer_symbol,
        gamma: contract.greeks.gamma,
        open_interest: contract.summary.open_interest,
      })),
    );
  });

  test("returns partial batch provenance while preserving successful symbols", async () => {
    const { client, expirations } = generatedFixture({
      expirationCount: 1,
      strikeCount: 4,
      maxFrameBytes: 512,
      maxConcurrentBatches: 1,
      failedBatchIndex: 1,
    });

    const result = await client.getLiveOptionSnapshot({
      underlying: "SPX",
      expirations,
      around_price: "7683.69",
      strike_count: 4,
      include_quotes: false,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
      deadline_ms: 5000,
      max_temporal_skew_ms: 1000,
    });

    expect(result.status).toBe("PARTIAL");
    expect(result.snapshot_complete).toBe(false);
    expect(result.contracts).toHaveLength(16);
    expect(
      new Set(
        result.contracts.map((contract) => contract.streamer_symbol),
      ).size,
    ).toBe(16);
    expect(result.transport.batch_count).toBeGreaterThan(1);
    expect(result.transport.failed_batches).toBe(1);
    expect(result.transport.complete_batches).toBeGreaterThan(0);
    const failedBatch = result.transport.batches.find(
      (batch) => batch.status === "FAILED",
    );
    expect(failedBatch).toMatchObject({
      batch_index: 2,
      status: "FAILED",
      error: expect.stringContaining("TEST_BATCH_FAILURE"),
    });
    expect(failedBatch.affected_symbols.length).toBeGreaterThan(0);
    expect(
      result.gamma_concentration_proxy.data_completeness
        .eligible_contracts,
    ).toBeGreaterThan(0);
    expect(result.gamma_concentration_proxy.status).toBe("PARTIAL");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "DXLINK_BATCH_FAILED",
        "GREEKS_COVERAGE_INCOMPLETE",
        "SUMMARY_OPEN_INTEREST_COVERAGE_INCOMPLETE",
      ]),
    );
  });
});
