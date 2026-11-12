// The Track A timing runners of TESTS.md §2: A1, A2, A3, A4 and A11.
import type { TestRunner } from "../../run/registry.ts";
import { a1ColdStart } from "./a1-cold-start.ts";
import { a2Relaunch } from "./a2-relaunch.ts";
import { a3ThreadOpen } from "./a3-thread-open.ts";
import { a4FirstWord } from "./a4-first-word.ts";
import { a11LongThread } from "./a11-long-thread.ts";

export const runners: TestRunner[] = [a1ColdStart, a2Relaunch, a3ThreadOpen, a4FirstWord, a11LongThread];
