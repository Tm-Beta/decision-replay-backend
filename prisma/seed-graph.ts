import { PrismaClient } from "@prisma/client";
import { snapshotsService } from "../src/modules/snapshots/snapshots.service";

const prisma = new PrismaClient();

async function createDecisionWithGraph(params: {
  userId: string;
  projectId: string | null;
  title: string;
  choice: string;
  expectedOutcome: string;
  decisionReason?: string;
  confidence?: number;
  reviewDaysFromNow?: number | null;
  parentId?: string | null;
  createdAtOffsetDays?: number;
  assumptions?: Array<{
    statement: string;
    metricTarget?: string;
    metricActual?: string;
    confidence: number;
    validated?: boolean;
  }>;
  alternatives?: Array<{ title: string; pros: string; cons: string }>;
  preMortems?: Array<{
    failureScenario: string;
    preventiveAction: string;
    severityScore: number;
    occurredInReality?: boolean;
  }>;
  outcome?: {
    actualOutcome: string;
    outcomeScore: number;
    reflection: string;
    wouldRepeat: boolean;
    unexpectedFactors: string;
    extraOutcomes?: Array<{ title: string; detail: string }>;
  };
  sourceLinks?: Array<{ type: "DECISION" | "OUTCOME"; id: string }>;
}) {
  const createdAt = new Date(
    Date.now() - (params.createdAtOffsetDays ?? 5) * 86400000,
  );
  const reviewDate =
    params.reviewDaysFromNow != null
      ? new Date(Date.now() + params.reviewDaysFromNow * 86400000)
      : null;

  const decision = await prisma.decision.create({
    data: {
      userId: params.userId,
      projectId: params.projectId,
      parentId: params.parentId ?? null,
      title: params.title,
      choice: params.choice,
      context: "",
      decisionReason: params.decisionReason ?? "",
      beliefRationale: "",
      expectedOutcome: params.expectedOutcome,
      confidence: params.confidence ?? null,
      reviewDate,
      status: params.outcome ? "REPLAYED" : "LOCKED",
      lockedAt: createdAt,
      createdAt,
      assumptions: {
        create: (params.assumptions ?? []).map((a) => ({
          statement: a.statement,
          metricTarget: a.metricTarget ?? null,
          metricActual: a.metricActual ?? null,
          confidence: a.confidence,
          validated: a.validated ?? null,
        })),
      },
      alternatives: {
        create: (params.alternatives ?? []).map((alt) => ({
          title: alt.title,
          pros: alt.pros,
          cons: alt.cons,
        })),
      },
      preMortems: {
        create: (params.preMortems ?? []).map((pm) => ({
          failureScenario: pm.failureScenario,
          preventiveAction: pm.preventiveAction,
          severityScore: pm.severityScore,
          occurredInReality: pm.occurredInReality ?? null,
        })),
      },
      events: {
        create: {
          eventType: "EVIDENCE_NOTE",
          title: "Decision Locked",
          detail: "Original decision recorded.",
          createdAt,
        },
      },
    },
  });

  await snapshotsService.freezeSnapshot(decision.id, {
    title: params.title,
    choice: params.choice,
    decisionReason: params.decisionReason ?? "",
    expectedOutcome: params.expectedOutcome,
    confidence: params.confidence ?? null,
    assumptions: params.assumptions ?? [],
    alternatives: params.alternatives ?? [],
    preMortems: params.preMortems ?? [],
  });

  const outcomeBranches: Array<{ id: string; title: string }> = [];

  if (params.outcome) {
    const recordedAt = new Date(createdAt.getTime() + 2 * 86400000);
    await prisma.outcome.create({
      data: {
        decisionId: decision.id,
        actualOutcome: params.outcome.actualOutcome,
        outcomeScore: params.outcome.outcomeScore,
        reflection: params.outcome.reflection,
        wouldRepeat: params.outcome.wouldRepeat,
        unexpectedFactors: params.outcome.unexpectedFactors,
        recordedAt,
      },
    });
    await prisma.timelineEvent.create({
      data: {
        decisionId: decision.id,
        eventType: "EVIDENCE_NOTE",
        title: "Replay Completed",
        detail: "Actual outcome recorded.",
        createdAt: recordedAt,
      },
    });

    if (params.projectId) {
      const primaryTitle =
        params.outcome.actualOutcome.split(/[\n.]/)[0]?.slice(0, 75) ||
        params.outcome.actualOutcome.slice(0, 75);
      const primary = await prisma.outcomeBranch.create({
        data: {
          projectId: params.projectId,
          decisionId: decision.id,
          title: primaryTitle,
          detail: params.outcome.actualOutcome,
          isPrimary: true,
        },
      });
      outcomeBranches.push(primary);
      await prisma.graphLink.create({
        data: {
          projectId: params.projectId,
          fromType: "DECISION",
          fromId: decision.id,
          toType: "OUTCOME",
          toId: primary.id,
        },
      });

      for (const extra of params.outcome.extraOutcomes ?? []) {
        const ob = await prisma.outcomeBranch.create({
          data: {
            projectId: params.projectId,
            decisionId: decision.id,
            title: extra.title,
            detail: extra.detail,
            isPrimary: false,
          },
        });
        outcomeBranches.push(ob);
        await prisma.graphLink.create({
          data: {
            projectId: params.projectId,
            fromType: "DECISION",
            fromId: decision.id,
            toType: "OUTCOME",
            toId: ob.id,
          },
        });
      }
    }
  }

  if (params.projectId) {
    const links = [...(params.sourceLinks ?? [])];
    if (!links.length && params.parentId) {
      links.push({ type: "DECISION", id: params.parentId });
    }
    for (const s of links) {
      await prisma.graphLink.create({
        data: {
          projectId: params.projectId,
          fromType: s.type,
          fromId: s.id,
          toType: "DECISION",
          toId: decision.id,
        },
      });
    }
  }

  return { decision, outcomeBranches };
}

async function main() {
  const user =
    (await prisma.user.findUnique({ where: { email: "achamath1@gmail.com" } })) ??
    (await prisma.user.findFirst());
  if (!user) {
    throw new Error("No user found in database to seed.");
  }

  console.log(`Cleaning old collections & decisions...`);
  await prisma.reviewPushDelivery.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.graphLink.deleteMany({});
  await prisma.outcomeBranch.deleteMany({});
  await prisma.decision.updateMany({ data: { parentId: null, planId: null } });
  await prisma.decision.deleteMany({});
  await prisma.branchPlan.deleteMany({});
  await prisma.project.deleteMany({});

  // =========================================================================
  // COLLECTION 1: University & Career Path (Exam -> Multi Outcomes -> Converge)
  // =========================================================================
  const uniProject = await prisma.project.create({
    data: {
      userId: user.id,
      name: "University & Career Path",
      purpose: "Map exam results, university options, and career skills",
      desiredOutcome: "Graduate with strong technical and communication skills",
    },
  });

  const d1 = await createDecisionWithGraph({
    userId: user.id,
    projectId: uniProject.id,
    title: "Sit A/L Physical Science Exam",
    choice: "Prepare full-time for Combined Maths, Physics, and Chemistry",
    expectedOutcome: "Achieve at least A, B, B to qualify for top state engineering faculties",
    decisionReason: "Want to pursue computer engineering without private tuition debt",
    confidence: 78,
    createdAtOffsetDays: 45,
    assumptions: [
      {
        statement: "Complete 10 years of past papers before exam week",
        metricTarget: ">= 10 papers",
        metricActual: "12 papers",
        confidence: 80,
        validated: true,
      },
      {
        statement: "Study at least 8 hours daily during final month",
        metricTarget: ">= 8 hrs",
        metricActual: "7.5 hrs",
        confidence: 70,
        validated: false,
      },
    ],
    alternatives: [
      {
        title: "Enroll straight into a private IT degree",
        pros: "Finish university 1 year faster",
        cons: "High tuition cost for family",
      },
    ],
    preMortems: [
      {
        failureScenario: "Burnout in the last 3 weeks drops Physics recall",
        preventiveAction: "Keep Sunday evenings completely off for rest",
        severityScore: 70,
        occurredInReality: false,
      },
    ],
    outcome: {
      actualOutcome: "Scored A, B, B (District Rank 185)",
      outcomeScore: 88,
      reflection: "Structured past paper practice worked very well; keeping Sundays free prevented burnout.",
      wouldRepeat: true,
      unexpectedFactors: "Chemistry paper had an unfamiliar organic synthesis question",
      extraOutcomes: [
        {
          title: "Qualified for State Engineering Z-Score",
          detail: "Cleared cutoff for top state engineering universities",
        },
      ],
    },
  });

  const d2 = await createDecisionWithGraph({
    userId: user.id,
    projectId: uniProject.id,
    title: "Apply to Top State Engineering Faculty",
    choice: "Select Computer Science & Engineering as first preference",
    expectedOutcome: "Secure admission to CSE specialization in the first round",
    decisionReason: "Strong interest in building software and AI systems",
    confidence: 85,
    createdAtOffsetDays: 32,
    parentId: d1.decision.id,
    sourceLinks: [{ type: "OUTCOME", id: d1.outcomeBranches[0].id }],
    assumptions: [
      {
        statement: "Cutoff rank stays within top 220",
        metricTarget: "< 220 rank",
        metricActual: "185 rank",
        confidence: 85,
        validated: true,
      },
    ],
    outcome: {
      actualOutcome: "Selected for Computer Science & Engineering",
      outcomeScore: 95,
      reflection: "First choice approved cleanly.",
      wouldRepeat: true,
      unexpectedFactors: "",
    },
  });

  // Independent branch joining the same collection!
  const d3 = await createDecisionWithGraph({
    userId: user.id,
    projectId: uniProject.id,
    title: "Take part-time UI/UX freelance project",
    choice: "Design a landing page and dashboard for a local bakery before semester starts",
    expectedOutcome: "Earn LKR 85,000 and gain real client communication experience",
    decisionReason: "Have 3 free months while waiting for university intake",
    confidence: 70,
    createdAtOffsetDays: 28,
    assumptions: [
      {
        statement: "Finish design & handoff under 21 days",
        metricTarget: "< 21 days",
        metricActual: "26 days",
        confidence: 75,
        validated: false,
      },
      {
        statement: "Project expenses stay under $50",
        metricTarget: "< $50",
        metricActual: "$35",
        confidence: 85,
        validated: true,
      },
    ],
    preMortems: [
      {
        failureScenario: "Client keeps adding extra pages without extra fee",
        preventiveAction: "Sign a clear 5-screen scope before starting",
        severityScore: 65,
        occurredInReality: true,
      },
    ],
    outcome: {
      actualOutcome: "Earned LKR 95,000 & built strong portfolio",
      outcomeScore: 82,
      reflection: "Scope expanded slightly by 5 days, but extra screen paid more.",
      wouldRepeat: true,
      unexpectedFactors: "Client requested mobile checkout flow mid-way",
    },
  });

  // CONVERGING DECISION: combines BOTH University admission outcome AND Freelance portfolio outcome!
  const d4 = await createDecisionWithGraph({
    userId: user.id,
    projectId: uniProject.id,
    title: "Start Spoken & Business English Course",
    choice: "Join a 12-week weekend communication & presentation program",
    expectedOutcome: "Present confidently in university seminars and international client calls",
    decisionReason: "Both CSE lectures and freelance clients require strong English fluency",
    confidence: 82,
    createdAtOffsetDays: 10,
    reviewDaysFromNow: 7,
    parentId: d2.decision.id,
    sourceLinks: [
      { type: "OUTCOME", id: d2.outcomeBranches[0].id },
      { type: "OUTCOME", id: d3.outcomeBranches[0].id },
    ],
    assumptions: [
      {
        statement: "Attend all 12 weekend workshops without skipping",
        metricTarget: "12 sessions",
        confidence: 80,
      },
    ],
  });

  // Plans inside Collection 1: Conditional outcomes + convergence!
  const pChooseTrack = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      originId: d2.decision.id,
      title: "Choose Final Year Specialization",
      expectedOutcome: "Pick the track that matches GPA and industry demand",
    },
  });
  await prisma.graphLink.create({
    data: {
      projectId: uniProject.id,
      fromType: "OUTCOME",
      fromId: d2.outcomeBranches[0].id,
      toType: "PLAN",
      toId: pChooseTrack.id,
    },
  });

  const pOutHigh = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "OUTCOME",
      parentPlanId: pChooseTrack.id,
      title: "High GPA (> 3.7) & AI Lab Offer",
      expectedOutcome: "Eligible for research honors",
    },
  });
  const pOutMid = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "OUTCOME",
      parentPlanId: pChooseTrack.id,
      title: "Solid GPA (3.1–3.6)",
      expectedOutcome: "Strong engineering base for industry roles",
    },
  });
  const pOutExp = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "OUTCOME",
      parentPlanId: pChooseTrack.id,
      title: "Need hands-on team experience first",
      expectedOutcome: "Better suited for practical product work",
    },
  });

  for (const outPlan of [pOutHigh, pOutMid, pOutExp]) {
    await prisma.graphLink.create({
      data: {
        projectId: uniProject.id,
        fromType: "PLAN",
        fromId: pChooseTrack.id,
        toType: "PLAN",
        toId: outPlan.id,
      },
    });
  }

  const pTrackAI = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      parentPlanId: pOutHigh.id,
      title: "Join AI Research Track",
      expectedOutcome: "Publish 1 research paper before graduation",
    },
  });
  const pTrackSWE = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      parentPlanId: pOutMid.id,
      title: "Focus on Full-Stack Engineering",
      expectedOutcome: "Build 3 production-grade systems",
    },
  });
  const pTrackIntern = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      parentPlanId: pOutExp.id,
      title: "Do 6-Month Paid Software Internship",
      expectedOutcome: "Gain production team experience and full-time return offer",
    },
  });
  const pGSoC = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      title: "Apply for Google Summer of Code",
      expectedOutcome: "Contribute to a global open-source project and earn stipend",
    },
  });

  // Converging Planned Decision: AI Track + SWE Track + GSoC + English Course -> Overseas MSc / Remote Job!
  const pConvergeCareer = await prisma.branchPlan.create({
    data: {
      projectId: uniProject.id,
      nodeType: "DECISION",
      parentPlanId: pTrackSWE.id,
      title: "Apply for Global Remote Role or MSc",
      expectedOutcome: "Combine degree, English fluency, and portfolio for top global offers",
    },
  });

  const planEdges: Array<{ fromType: string; fromId: string; toType: string; toId: string }> = [
    { fromType: "PLAN", fromId: pOutHigh.id, toType: "PLAN", toId: pTrackAI.id },
    { fromType: "PLAN", fromId: pOutMid.id, toType: "PLAN", toId: pTrackSWE.id },
    { fromType: "PLAN", fromId: pOutExp.id, toType: "PLAN", toId: pTrackIntern.id },
    { fromType: "PLAN", fromId: pTrackAI.id, toType: "PLAN", toId: pConvergeCareer.id },
    { fromType: "PLAN", fromId: pTrackSWE.id, toType: "PLAN", toId: pConvergeCareer.id },
    { fromType: "PLAN", fromId: pTrackIntern.id, toType: "PLAN", toId: pConvergeCareer.id },
    { fromType: "PLAN", fromId: pGSoC.id, toType: "PLAN", toId: pConvergeCareer.id },
    { fromType: "DECISION", fromId: d4.decision.id, toType: "PLAN", toId: pConvergeCareer.id },
  ];
  for (const pe of planEdges) {
    await prisma.graphLink.create({ data: { projectId: uniProject.id, ...pe } });
  }

  // =========================================================================
  // COLLECTION 2: Side-Project App Launch (Product Strategy + DNA Metrics)
  // =========================================================================
  const appProject = await prisma.project.create({
    data: {
      userId: user.id,
      name: "Side-Project App Launch",
      purpose: "Build and grow a micro-SaaS app cleanly",
      desiredOutcome: "Reach 50 paying users",
    },
  });

  const b1 = await createDecisionWithGraph({
    userId: user.id,
    projectId: appProject.id,
    title: "Build MVP in 3 weeks",
    choice: "Build core workflow using Next.js + SQLite and skip billing v1",
    expectedOutcome: "Launch working beta within 21 days with under $40 infra cost",
    decisionReason: "Validate demand before writing complex payment webhooks",
    confidence: 88,
    createdAtOffsetDays: 35,
    assumptions: [
      {
        statement: "Ship MVP within 21 days",
        metricTarget: "< 21 days",
        metricActual: "25 days",
        confidence: 85,
        validated: false,
      },
      {
        statement: "Hosting & domain spend stays under $40",
        metricTarget: "< $40",
        metricActual: "$28",
        confidence: 90,
        validated: true,
      },
    ],
    alternatives: [
      {
        title: "Build custom mobile app with React Native first",
        pros: "Native push notifications",
        cons: "Takes 2x longer to ship",
      },
    ],
    preMortems: [
      {
        failureScenario: "Auth edge cases delay launch by a week",
        preventiveAction: "Use Google Sign-In only for beta",
        severityScore: 60,
        occurredInReality: true,
      },
    ],
    outcome: {
      actualOutcome: "Shipped MVP on Day 25 to first 40 beta testers",
      outcomeScore: 76,
      reflection: "Skipping billing was right, though auth took 4 extra days.",
      wouldRepeat: true,
      unexpectedFactors: "Mobile layout needed extra polish",
      extraOutcomes: [
        {
          title: "40 Beta Users Signed Up",
          detail: "Shared demo link in two student Discord servers",
        },
      ],
    },
  });

  const b2 = await createDecisionWithGraph({
    userId: user.id,
    projectId: appProject.id,
    title: "Post launch thread on Reddit & LinkedIn",
    choice: "Publish short walkthrough video + demo link",
    expectedOutcome: "Drive 250 visitors and 10 early adopters",
    confidence: 72,
    createdAtOffsetDays: 22,
    parentId: b1.decision.id,
    sourceLinks: [{ type: "OUTCOME", id: b1.outcomeBranches[0].id }],
    assumptions: [
      {
        statement: "Get at least 250 visitors in 48 hours",
        metricTarget: ">= 250",
        metricActual: "340",
        confidence: 70,
        validated: true,
      },
    ],
    outcome: {
      actualOutcome: "340 visitors and 14 active weekly users",
      outcomeScore: 84,
      reflection: "Short video outperformed text post 3x.",
      wouldRepeat: true,
      unexpectedFactors: "",
    },
  });

  const b3 = await createDecisionWithGraph({
    userId: user.id,
    projectId: appProject.id,
    title: "Interview 8 beta users on Zoom",
    choice: "Watch them use the form without giving hints",
    expectedOutcome: "Identify top 3 UX friction points",
    confidence: 80,
    createdAtOffsetDays: 18,
    parentId: b1.decision.id,
    sourceLinks: [{ type: "OUTCOME", id: b1.outcomeBranches[1].id }],
    outcome: {
      actualOutcome: "Discovered users didn't understand technical labels",
      outcomeScore: 90,
      reflection: "Seeing real confusion live changed our UI completely.",
      wouldRepeat: true,
      unexpectedFactors: "Users wanted scenario branching in Plans",
    },
  });

  // Converging decision combining Launch traffic outcome + User interview outcome!
  const b4 = await createDecisionWithGraph({
    userId: user.id,
    projectId: appProject.id,
    title: "Redesign forms & add Scenario Graph",
    choice: "Replace technical jargon with plain everyday labels and interactive graph",
    expectedOutcome: "Increase form completion rate above 80%",
    confidence: 85,
    createdAtOffsetDays: 5,
    reviewDaysFromNow: 0, // Due now for testing notifications & due alerts!
    parentId: b2.decision.id,
    sourceLinks: [
      { type: "OUTCOME", id: b2.outcomeBranches[0].id },
      { type: "OUTCOME", id: b3.outcomeBranches[0].id },
    ],
    assumptions: [
      {
        statement: "Ship redesign within 10 days",
        metricTarget: "< 10 days",
        confidence: 80,
      },
    ],
  });

  // Plans for App Launch
  const pAds = await prisma.branchPlan.create({
    data: {
      projectId: appProject.id,
      nodeType: "DECISION",
      originId: b4.decision.id,
      title: "Run $60 Creator Newsletter Sponsorship",
      expectedOutcome: "Test paid acquisition cost (CAC)",
    },
  });
  const pAdsWin = await prisma.branchPlan.create({
    data: {
      projectId: appProject.id,
      nodeType: "OUTCOME",
      parentPlanId: pAds.id,
      title: "CAC under $10 (Profitable)",
      expectedOutcome: "Healthy conversion",
    },
  });
  const pAdsLose = await prisma.branchPlan.create({
    data: {
      projectId: appProject.id,
      nodeType: "OUTCOME",
      parentPlanId: pAds.id,
      title: "CAC over $25 (Too costly)",
      expectedOutcome: "Paid ads unsustainable yet",
    },
  });
  const pScale = await prisma.branchPlan.create({
    data: {
      projectId: appProject.id,
      nodeType: "DECISION",
      parentPlanId: pAdsWin.id,
      title: "Double monthly ad budget to $150",
      expectedOutcome: "Grow to 100 active users",
    },
  });
  const pContent = await prisma.branchPlan.create({
    data: {
      projectId: appProject.id,
      nodeType: "DECISION",
      parentPlanId: pAdsLose.id,
      title: "Pivot to organic YouTube tutorials",
      expectedOutcome: "Zero ad spend, build long-term trust",
    },
  });
  for (const link of [
    { fromType: "DECISION", fromId: b4.decision.id, toType: "PLAN", toId: pAds.id },
    { fromType: "PLAN", fromId: pAds.id, toType: "PLAN", toId: pAdsWin.id },
    { fromType: "PLAN", fromId: pAds.id, toType: "PLAN", toId: pAdsLose.id },
    { fromType: "PLAN", fromId: pAdsWin.id, toType: "PLAN", toId: pScale.id },
    { fromType: "PLAN", fromId: pAdsLose.id, toType: "PLAN", toId: pContent.id },
  ]) {
    await prisma.graphLink.create({ data: { projectId: appProject.id, ...link } });
  }

  // =========================================================================
  // COLLECTION 3: Personal Fitness & Focus Routine
  // =========================================================================
  const habitProject = await prisma.project.create({
    data: {
      userId: user.id,
      name: "Daily Focus & Fitness",
      purpose: "Build sustainable energy and deep study habits",
      desiredOutcome: "Consistent 4 hours deep focus daily",
    },
  });

  const h1 = await createDecisionWithGraph({
    userId: user.id,
    projectId: habitProject.id,
    title: "5:30 AM Morning Gym + Study Challenge",
    choice: "Wake up at 5:30 AM every day for 30 days",
    expectedOutcome: "Finish gym and 2 hours study before 9:00 AM",
    confidence: 92,
    createdAtOffsetDays: 40,
    assumptions: [
      {
        statement: "Stick to schedule at least 26 of 30 days",
        metricTarget: ">= 26 days",
        metricActual: "19 days",
        confidence: 90,
        validated: false,
      },
    ],
    preMortems: [
      {
        failureScenario: "Late night coding ruins 5:30 AM wake-up",
        preventiveAction: "Put laptop away by 10:15 PM",
        severityScore: 80,
        occurredInReality: true,
      },
    ],
    outcome: {
      actualOutcome: "Completed 19 of 30 days — mornings felt rushed",
      outcomeScore: 62,
      reflection: "Overestimated morning willpower after late coding nights.",
      wouldRepeat: false,
      unexpectedFactors: "Heavy rain made morning commute exhausting",
    },
  });

  const h2 = await createDecisionWithGraph({
    userId: user.id,
    projectId: habitProject.id,
    title: "Move gym to 5:30 PM & keep mornings for coding",
    choice: "Wake at 6:30 AM for quiet deep work, exercise in evening",
    expectedOutcome: "Hit 25+ consistent study days this month",
    confidence: 76,
    createdAtOffsetDays: 14,
    parentId: h1.decision.id,
    sourceLinks: [{ type: "OUTCOME", id: h1.outcomeBranches[0].id }],
    assumptions: [
      {
        statement: "Study consistency above 85%",
        metricTarget: ">= 85%",
        metricActual: "92%",
        confidence: 78,
        validated: true,
      },
    ],
    outcome: {
      actualOutcome: "Hit 92% consistency & better sleep quality",
      outcomeScore: 91,
      reflection: "Adjusting based on actual data worked dramatically better.",
      wouldRepeat: true,
      unexpectedFactors: "",
    },
  });

  await createDecisionWithGraph({
    userId: user.id,
    projectId: habitProject.id,
    title: "Batch phone notifications to 2 slots daily",
    choice: "Turn off social alerts until 1 PM and 7 PM",
    expectedOutcome: "Double uninterrupted deep-work blocks",
    confidence: 80,
    createdAtOffsetDays: 3,
    reviewDaysFromNow: 11,
    parentId: h2.decision.id,
    sourceLinks: [{ type: "OUTCOME", id: h2.outcomeBranches[0].id }],
  });

  // =========================================================================
  // INDIVIDUAL DECISIONS (Outside Collections)
  // =========================================================================
  await createDecisionWithGraph({
    userId: user.id,
    projectId: null,
    title: "Switch to annual cloud storage plan",
    choice: "Pay yearly instead of monthly for 2TB backup",
    expectedOutcome: "Save $24/year and eliminate backup warnings",
    confidence: 95,
    createdAtOffsetDays: 16,
    assumptions: [
      {
        statement: "Annual cost stays under $100",
        metricTarget: "< $100",
        metricActual: "$96",
        confidence: 95,
        validated: true,
      },
    ],
    outcome: {
      actualOutcome: "Saved $24 and automated laptop backups",
      outcomeScore: 94,
      reflection: "Simple win with zero hassle.",
      wouldRepeat: true,
      unexpectedFactors: "",
    },
  });

  await createDecisionWithGraph({
    userId: user.id,
    projectId: null,
    title: "Upgrade home fiber router for smoother calls",
    choice: "Buy dual-band Wi-Fi 6 router",
    expectedOutcome: "Zero video call drops from study room",
    confidence: 85,
    createdAtOffsetDays: 2,
    reviewDaysFromNow: 5,
  });

  console.log("✅ Seeded 3 rich collections, 14 decisions, 10 outcomes, 10 scenario plans, and converging graph links for", user.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
