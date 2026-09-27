import type { BacktestStrikeSelector } from "./backtest-selector.js";
import type { OptionSide } from "./spread-adapter.js";

export const HISTORICAL_SPX_CANDIDATE_PROGRESS_STAGES = [
  "CACHE_LOOKUP",
  "PROVIDER_BOOTSTRAP",
  "CONTRACT_UNIVERSE",
  "CANDLE_RECONSTRUCTION",
  "SELECTOR_EVALUATION",
] as const;

export type HistoricalSpxCandidateProgressStage =
  (typeof HISTORICAL_SPX_CANDIDATE_PROGRESS_STAGES)[number];

export type HistoricalSpxCandidateProgressSelector = {
  option_side: OptionSide;
  method: BacktestStrikeSelector["method"];
  value: string;
  days_until_expiration: number;
};

export type HistoricalSpxCandidateProgressEvent = {
  stage: HistoricalSpxCandidateProgressStage;
  state: "STARTED" | "PROGRESS" | "COMPLETED" | "FAILED";
  selector?: HistoricalSpxCandidateProgressSelector;
};

export type HistoricalSpxCandidateProgressReporter = (
  event: HistoricalSpxCandidateProgressEvent,
) => void;

export type HistoricalSpxCandidateProgressOptions = {
  on_progress?: HistoricalSpxCandidateProgressReporter;
};
