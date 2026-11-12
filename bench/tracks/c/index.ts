// Track C runners: orchestration and reliability (TESTS.md §4). Every runner is loaded by the registry.
import type { TestRunner } from "../../run/registry.ts";
import { c1 } from "./c1-orchestrated-build.ts";
import { c2 } from "./c2-message-delivery.ts";
import { c3 } from "./c3-chat-lock.ts";
import { c4 } from "./c4-agent-killed.ts";
import { c5 } from "./c5-network-cut.ts";
import { c6 } from "./c6-app-restart.ts";

export const runners: TestRunner[] = [c1, c2, c3, c4, c5, c6];
