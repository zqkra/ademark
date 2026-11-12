// The four Track B runners, in TESTS.md §3 order.
import type { TestRunner } from "../../run/registry.ts";
import { b1HelloTax } from "./b1-hello-tax.ts";
import { b2RequestAnatomy } from "./b2-request-anatomy.ts";
import { b3RealPromptTax } from "./b3-real-prompt-tax.ts";
import { b4RepoRules } from "./b4-repo-rules.ts";

export const runners: TestRunner[] = [b1HelloTax, b3RealPromptTax, b2RequestAnatomy, b4RepoRules];
