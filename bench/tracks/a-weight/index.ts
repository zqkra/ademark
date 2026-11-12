// The Track A weight runners A5 to A10, plus A12, which runs in the Track C block (TESTS.md §2).
import type { TestRunner } from "../../run/registry.ts";
import { weighIn } from "./a5-weigh-in.ts";
import { idleBurn } from "./a6-idle-burn.ts";
import { fightWeight } from "./a7-fight-weight.ts";
import { typingLag } from "./a8-typing-lag.ts";
import { ghostWeight } from "./a9-ghost-weight.ts";
import { scale } from "./a10-scale.ts";
import { leak } from "./a12-leak.ts";

export const runners: TestRunner[] = [weighIn, idleBurn, fightWeight, typingLag, ghostWeight, scale, leak];
