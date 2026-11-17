import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { aiConfig } from "../../config/ai.config";
import {
  findViolations,
  parseLooseJson,
  sanitizeChallenge,
  sanitizeReplayAnalysis,
} from "./guardrails";
import {
  aiAnalystService,
  buildDeterministicChallenge,
  buildDeterministicReplayAnalysis,
  SocraticChallengeRequest,
  PostReplayAnalysisRequest,
} from "./ai.service";

const ENV_KEYS = ["AI_API_KEY", "AI_MODEL", "AI_GATEWAY_URL", "AI_TEMPERATURE", "AI_MAX_TOKENS", "AI_TIMEOUT_MS"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k]; // default for every test: no key = mock mode
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draft = (over: Partial<SocraticChallengeRequest> = {}): SocraticChallengeRequest => ({
  title: "T",
  choice: "C",
  decisionReason: "Because",
  expectedOutcome: "Customers are happy",
  confidence: 60,
  assumptions: [{ statement: "Costs stay under 500", metricTarget: "$500" }],
  alternatives: [{ title: "A" }, { title: "B" }],
  preMortems: [{ failureScenario: "It breaks" }],
  ...over,
});

const replay = (over: Partial<PostReplayAnalysisRequest> = {}): PostReplayAnalysisRequest => ({
  decisionId: "d1",
  expectedOutcome: "Ship in 2 weeks",
  actualOutcome: "Shipped in 3 weeks",
  confidence: 80,
  outcomeScore: 60,
  assumptions: [
    { statement: "Rewrite takes under two weeks", validated: false },
    { statement: "Users like it", validated: true },
  ],
  ...over,
});

const okFetch = (content: string) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });

const validChallenge = {
  socraticQuestions: [
    {
      focusArea: "Assumption Rigor",
      question: "What evidence would show this assumption is wrong?",
      suggestedAction: "Add a numeric target.",
    },
  ],
  detectedBiases: ["planning fallacy"],
};

describe("guardrail filter", () => {
  it("flags prescriptive, diagnostic, hindsight and certainty language", () => {
    expect(findViolations("You should choose option A")).toContain("G-01 prescriptive");
    expect(findViolations("Option B is the best here")).toContain("G-01 prescriptive");
    expect(findViolations("The best option is clear")).toContain("G-01 prescriptive");
    expect(findViolations("You are a reckless person")).toContain("G-03 diagnosis");
    expect(findViolations("You should have known this would happen")).toContain("hindsight");
    expect(findViolations("This will definitely fail")).toContain("G-04 certainty");
  });

  it("accepts Socratic, evidence-based wording", () => {
    expect(findViolations("What evidence would disprove this assumption?")).toEqual([]);
    expect(findViolations("You should add a number to this assumption")).toEqual([]);
    expect(findViolations("What criteria matter most to your outcome?")).toEqual([]);
  });
});

describe("parseLooseJson / sanitize", () => {
  it("parses fenced JSON and rejects garbage", () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson("Here you go: {\"a\":2} thanks")).toEqual({ a: 2 });
    expect(parseLooseJson("no json here")).toBeNull();
    expect(parseLooseJson(42)).toBeNull();
  });

  it("normalizes biases and keeps clean questions", () => {
    const out = sanitizeChallenge(validChallenge);
    expect(out?.detectedBiases).toEqual(["PLANNING_FALLACY"]);
    expect(out?.socraticQuestions).toHaveLength(1);
  });

  it("drops only the violating question, and rejects when none are left", () => {
    const bad = { focusArea: "X", question: "You should choose option A.", suggestedAction: "Do it." };
    const mixed = sanitizeChallenge({ socraticQuestions: [bad, ...validChallenge.socraticQuestions] });
    expect(mixed?.socraticQuestions).toHaveLength(1);
    expect(sanitizeChallenge({ socraticQuestions: [bad] })).toBeNull();
    expect(sanitizeChallenge({ nope: true })).toBeNull();
  });

  it("rejects a replay analysis with any violation or missing field", () => {
    const good = {
      varianceExplanation: "One candidate explanation is a failed assumption.",
      reasoningPatternIdentified: "Falsified Hypothesis",
      socraticTakeaway: "Which early signal would show this sooner?",
      repeatabilityAssessment: "Possibly repeatable, with uncertainty.",
    };
    expect(sanitizeReplayAnalysis(good)).not.toBeNull();
    expect(sanitizeReplayAnalysis({ ...good, socraticTakeaway: "You should have known." })).toBeNull();
    expect(sanitizeReplayAnalysis({ ...good, repeatabilityAssessment: undefined })).toBeNull();
  });
});

describe("deterministic challenge", () => {
  it("challenges an empty draft on assumptions and pre-mortem", () => {
    const out = buildDeterministicChallenge(
      draft({ assumptions: [], alternatives: [], preMortems: [], decisionReason: "" }),
    );
    const areas = out.socraticQuestions.map((q) => q.focusArea);
    expect(areas).toContain("Assumption Rigor");
    expect(areas).toContain("Pre-Mortem Blindspot");
    expect(out.socraticQuestions.length).toBeLessThanOrEqual(4);
    expect(out.detectedBiases).toEqual(expect.arrayContaining(["UNEXAMINED_ASSUMPTIONS", "OPTIMISM_BIAS"]));
  });

  it("asks how to measure a vague assumption", () => {
    const out = buildDeterministicChallenge(draft({ assumptions: [{ statement: "It will be fast" }] }));
    expect(out.socraticQuestions).toHaveLength(1);
    expect(out.socraticQuestions[0].question).toContain("It will be fast");
    expect(out.detectedBiases).toEqual(["UNEXAMINED_ASSUMPTIONS"]);
  });

  it("flags a schedule-dependent plan (planning fallacy)", () => {
    const out = buildDeterministicChallenge(draft({ expectedOutcome: "Ship the new page in 2 weeks" }));
    expect(out.detectedBiases).toContain("PLANNING_FALLACY");
  });

  it("challenges very high confidence", () => {
    const out = buildDeterministicChallenge(draft({ confidence: 95 }));
    expect(out.detectedBiases).toContain("OVERCONFIDENCE");
    expect(out.socraticQuestions[0].focusArea).toBe("Confidence Calibration");
  });

  it("falls back to one calibration question for a well-prepared draft", () => {
    const out = buildDeterministicChallenge(draft());
    expect(out.socraticQuestions).toHaveLength(1);
    expect(out.socraticQuestions[0].focusArea).toBe("Confidence Calibration");
    expect(out.detectedBiases).toEqual([]);
  });
});

describe("deterministic replay analysis", () => {
  it("traces the gap to a falsified assumption", () => {
    const out = buildDeterministicReplayAnalysis(replay());
    expect(out.varianceExplanation).toContain("1 of 2 assumptions");
    expect(out.reasoningPatternIdentified).toBe("Falsified Hypothesis");
  });

  it("says so when no assumptions were recorded", () => {
    const out = buildDeterministicReplayAnalysis(replay({ assumptions: [] }));
    expect(out.varianceExplanation).toContain("No assumptions were recorded");
  });

  it("labels confidence far above the outcome as overconfidence", () => {
    const out = buildDeterministicReplayAnalysis(
      replay({ confidence: 90, outcomeScore: 40, assumptions: [{ statement: "Users like it", validated: true }] }),
    );
    expect(out.reasoningPatternIdentified).toBe("Overconfidence");
  });
});

describe("all fallback wording obeys the guardrails", () => {
  it("has no violations in any deterministic output", () => {
    const challenges = [
      draft(),
      draft({ assumptions: [], alternatives: [], preMortems: [], decisionReason: "" }),
      draft({ confidence: 95, expectedOutcome: "Launch in 3 months", assumptions: [{ statement: "It will be fast" }] }),
    ].map(buildDeterministicChallenge);
    const replays = [
      replay(),
      replay({ assumptions: [] }),
      replay({ confidence: 90, outcomeScore: 40, assumptions: [{ statement: "A", validated: true }] }),
      replay({ confidence: 30, outcomeScore: 90, assumptions: [{ statement: "A", validated: true }] }),
      replay({ outcomeScore: 85, assumptions: [{ statement: "A", validated: true }] }),
    ].map(buildDeterministicReplayAnalysis);

    const texts = [
      ...challenges.flatMap((c) => c.socraticQuestions.map((q) => `${q.focusArea} ${q.question} ${q.suggestedAction}`)),
      ...replays.map((r) => Object.values(r).join(" ")),
    ];
    for (const t of texts) expect(findViolations(t)).toEqual([]);
  });
});

describe("service orchestration", () => {
  it("uses mock mode without a key and never calls the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await aiAnalystService.generatePreDecisionChallenge(draft());
    expect(out.mode).toBe("LOCAL_MOCK");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a valid live answer and sends the capped settings", async () => {
    process.env.AI_API_KEY = "test-key";
    const fetchMock = okFetch(JSON.stringify(validChallenge));
    vi.stubGlobal("fetch", fetchMock);

    const out = await aiAnalystService.generatePreDecisionChallenge(draft());
    expect(out.mode).toBe("LIVE_LLM");
    expect(out.detectedBiases).toEqual(["PLANNING_FALLACY"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/chat\/completions$/);
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(1200);
    expect(body.temperature).toBeLessThanOrEqual(0.4);
    expect(body.model).toBe("gpt-4o");
  });

  it("falls back when the live answer breaks a guardrail", async () => {
    process.env.AI_API_KEY = "test-key";
    const bad = {
      socraticQuestions: [{ focusArea: "X", question: "You should choose option A.", suggestedAction: "Go." }],
      detectedBiases: [],
    };
    vi.stubGlobal("fetch", okFetch(JSON.stringify(bad)));
    const out = await aiAnalystService.generatePreDecisionChallenge(draft());
    expect(out.mode).toBe("LOCAL_MOCK");
  });

  it("falls back on non-JSON text, HTTP errors and network failures", async () => {
    process.env.AI_API_KEY = "test-key";

    vi.stubGlobal("fetch", okFetch("Sorry, I cannot help with that."));
    expect((await aiAnalystService.generatePreDecisionChallenge(draft())).mode).toBe("LOCAL_MOCK");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    expect((await aiAnalystService.generatePreDecisionChallenge(draft())).mode).toBe("LOCAL_MOCK");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect((await aiAnalystService.generatePostReplayAnalysis(replay())).mode).toBe("LOCAL_MOCK");
  });

  it("returns a live replay analysis, but rejects hindsight wording", async () => {
    process.env.AI_API_KEY = "test-key";
    const good = {
      varianceExplanation: "One candidate explanation is the failed schedule assumption.",
      reasoningPatternIdentified: "Falsified Hypothesis",
      socraticTakeaway: "Which early signal would show this sooner?",
      repeatabilityAssessment: "Possibly repeatable, with uncertainty.",
    };
    vi.stubGlobal("fetch", okFetch(JSON.stringify(good)));
    expect((await aiAnalystService.generatePostReplayAnalysis(replay())).mode).toBe("LIVE_LLM");

    vi.stubGlobal("fetch", okFetch(JSON.stringify({ ...good, socraticTakeaway: "You should have known." })));
    expect((await aiAnalystService.generatePostReplayAnalysis(replay())).mode).toBe("LOCAL_MOCK");
  });
});

describe("ai config", () => {
  it("is mock mode until a key exists, read at call time", () => {
    expect(aiConfig.isMockMode).toBe(true);
    process.env.AI_API_KEY = "abc";
    expect(aiConfig.isMockMode).toBe(false);
  });

  it("caps temperature and tokens", () => {
    process.env.AI_TEMPERATURE = "0.9";
    process.env.AI_MAX_TOKENS = "99999";
    expect(aiConfig.temperature).toBe(0.4);
    expect(aiConfig.maxTokens).toBe(2000);
  });

  it("fixes the OpenRouter-style model name for the OpenAI API only", () => {
    process.env.AI_MODEL = "openai/gpt-4o";
    expect(aiConfig.model).toBe("gpt-4o");
    process.env.AI_GATEWAY_URL = "https://openrouter.ai/api/v1";
    expect(aiConfig.model).toBe("openai/gpt-4o");
  });
});
