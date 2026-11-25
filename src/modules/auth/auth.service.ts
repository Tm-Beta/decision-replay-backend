import { prisma } from "../../config/database";
import { OAuth2Client } from "google-auth-library";
import { generateSessionToken } from "../../common/security/token.utils";

export interface GoogleLoginDto {
  email: string;
  name: string;
  avatar?: string;
  googleId?: string;
  credential?: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatar?: string | null;
    preferences?: Record<string, unknown>;
  };
  token: string;
  isNewUser: boolean;
}

function parsePreferences(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class AuthService {
  /**
   * Verifies an official Google OAuth2 Access Token by querying Google's userinfo endpoint.
   */
  async verifyGoogleAccessToken(accessToken: string) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn("Google userinfo fetch failed:", response.status, errText);
      throw new Error(`Google userinfo request failed with status ${response.status}`);
    }

    const data = (await response.json()) as {
      sub: string;
      email: string;
      name?: string;
      picture?: string;
      email_verified?: boolean;
    };

    if (!data.email || data.email_verified !== true) {
      throw new Error("Google account did not return a valid email address");
    }

    return {
      email: data.email,
      name: data.name || data.email.split("@")[0],
      avatar: data.picture,
      googleId: data.sub,
    };
  }

  /**
   * Verifies an official Google Identity Services ID Token JWT.
   */
  async verifyGoogleToken(idToken: string) {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (googleClientId) {
      try {
        const oauthClient = new OAuth2Client(googleClientId);
        const ticket = await oauthClient.verifyIdToken({
          idToken,
          audience: googleClientId,
        });
        const payload = ticket.getPayload();
        if (payload && payload.email && payload.email_verified === true) {
          return {
            email: payload.email,
            name: payload.name || payload.email.split("@")[0],
            avatar: payload.picture,
            googleId: payload.sub,
          };
        }
      } catch (err) {
        console.warn("Google verifyIdToken failed, checking JWT payload fallback:", err);
      }
    }

    throw new Error("Unable to verify Google token");
  }

  async loginWithGoogle(data: GoogleLoginDto): Promise<AuthResponse> {
    const email = data.email.trim().toLowerCase();
    const name = data.name.trim() || email.split("@")[0];
    const avatar = data.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}`;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    const isNewUser = !existingUser;

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name,
        avatar,
      },
      create: {
        email,
        name,
        avatar,
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        preferences: true,
      },
    });

    // Cryptographically signed HMAC-SHA256 session token
    const token = generateSessionToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: parsePreferences(user.preferences),
      },
      token,
      isNewUser,
    };
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        preferences: true,
        createdAt: true,
      },
    });

    if (!user) return null;
    return {
      ...user,
      preferences: parsePreferences(user.preferences),
    };
  }

  async updatePreferences(userId: string, nextPrefs: Record<string, unknown>) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const merged = {
      ...parsePreferences(current?.preferences),
      ...nextPrefs,
    };
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { preferences: JSON.stringify(merged) },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        preferences: true,
      },
    });
    return {
      ...updated,
      preferences: parsePreferences(updated.preferences),
    };
  }

  async exportUserData(userId: string) {
    const [user, projects, decisions, chatSessions, chatMessages] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, preferences: true, createdAt: true },
      }),
      prisma.project.findMany({
        where: { userId },
        include: { plans: true, outcomeBranches: true, graphLinks: true },
      }),
      prisma.decision.findMany({
        where: { userId },
        include: {
          assumptions: true,
          alternatives: true,
          preMortems: true,
          events: true,
          outcome: true,
          outcomeBranches: true,
          snapshot: true,
        },
      }),
      prisma.chatSession.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.chatMessage.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      app: "So I Chose",
      version: 1,
      user: user ? { ...user, preferences: parsePreferences(user.preferences) } : null,
      projects,
      decisions,
      chatSessions,
      chatMessages,
    };
  }

  async importUserData(
    userId: string,
    backup: {
      preferences?: Record<string, unknown> | null;
      projects: Array<{
        id: string;
        name: string;
        purpose: string;
        desiredOutcome: string;
        status: string;
        horizon: string;
        constraints: string;
        principles: string;
        plans: Array<{
          id: string;
          status: string;
          nodeType: string;
          joinRule: string;
          originId?: string | null;
          parentPlanId?: string | null;
          title: string;
          expectedOutcome: string;
        }>;
        graphLinks: Array<{
          fromType: string;
          fromId: string;
          toType: string;
          toId: string;
          label?: string;
        }>;
      }>;
      decisions: Array<{
        id: string;
        title: string;
        category: string;
        projectId?: string | null;
        parentId?: string | null;
        planId?: string | null;
        joinRule?: string;
        influences?: string;
        decidedOn?: string | null;
        outcomeKnown?: boolean | null;
        context: string;
        decisionReason?: string;
        beliefRationale?: string;
        choice: string;
        expectedOutcome: string;
        confidence?: number | null;
        status: string;
        reviewDate?: string | null;
        assumptions: Array<{
          statement: string;
          metricTarget?: string | null;
          metricActual?: string | null;
          confidence: number;
          validated?: boolean | null;
        }>;
        alternatives: Array<{
          title: string;
          pros: string;
          cons: string;
          selected: boolean;
        }>;
        preMortems: Array<{
          failureScenario: string;
          preventiveAction: string;
          severityScore: number;
          occurredInReality?: boolean | null;
        }>;
        events: Array<{
          eventType: string;
          title: string;
          detail: string;
          metadataJson?: string | null;
        }>;
        outcome?: {
          actualOutcome: string;
          outcomeScore?: number | null;
          predictionAccuracy?: number | null;
          reflection: string;
          wouldRepeat?: boolean | null;
          unexpectedFactors?: string;
        } | null;
        outcomeBranches: Array<{
          id: string;
          projectId: string;
          planId?: string | null;
          title: string;
          detail: string;
          isPrimary: boolean;
        }>;
        snapshot?: {
          contentHash: string;
          payloadJson: string;
        } | null;
      }>;
      chatSessions?: Array<{
        id: string;
        projectId?: string | null;
        title: string;
      }>;
      chatMessages?: Array<{
        projectId?: string | null;
        sessionId?: string | null;
        role: string;
        content: string;
      }>;
    },
    restorePreferences = false,
  ) {
    return prisma.$transaction(async (tx) => {
      const projectIdMap = new Map<string, string>();
      const planIdMap = new Map<string, string>();
      const decisionIdMap = new Map<string, string>();
      const outcomeIdMap = new Map<string, string>();
      const sessionIdMap = new Map<string, string>();

      // 1. Create Projects with brand-new IDs scoped strictly to userId
      for (const proj of backup.projects) {
        const createdProj = await tx.project.create({
          data: {
            userId,
            name: proj.name,
            purpose: proj.purpose,
            desiredOutcome: proj.desiredOutcome,
            status: proj.status,
            horizon: proj.horizon,
            constraints: proj.constraints,
            principles: proj.principles,
          },
          select: { id: true },
        });
        projectIdMap.set(proj.id, createdProj.id);

        for (const plan of proj.plans) {
          const createdPlan = await tx.branchPlan.create({
            data: {
              projectId: createdProj.id,
              status: plan.status,
              nodeType: plan.nodeType,
              joinRule: plan.joinRule,
              title: plan.title,
              expectedOutcome: plan.expectedOutcome,
            },
            select: { id: true },
          });
          planIdMap.set(plan.id, createdPlan.id);
        }
      }

      // 2. Create Decisions with remapped projectId & planId (parentId linked in pass 3)
      for (const dec of backup.decisions) {
        const newProjId = dec.projectId ? (projectIdMap.get(dec.projectId) ?? null) : null;
        const newPlanId = dec.planId && newProjId ? (planIdMap.get(dec.planId) ?? null) : null;

        const createdDec = await tx.decision.create({
          data: {
            userId,
            projectId: newProjId,
            planId: newPlanId,
            joinRule: dec.joinRule === "ALL" ? "ALL" : "ANY",
            decidedOn: dec.decidedOn ?? null,
            outcomeKnown: dec.outcomeKnown ?? null,
            title: dec.title,
            category: dec.category,
            context: dec.context,
            decisionReason: dec.decisionReason ?? "",
            beliefRationale: dec.beliefRationale ?? "",
            choice: dec.choice,
            expectedOutcome: dec.expectedOutcome,
            confidence: dec.confidence ?? null,
            status: dec.status,
            reviewDate: (() => {
              if (!dec.reviewDate) return null;
              const d = new Date(dec.reviewDate);
              return Number.isNaN(d.getTime()) ? null : d;
            })(),
            snapshotHash: dec.snapshot?.contentHash ?? null,
            assumptions: {
              create: dec.assumptions.map((a) => ({
                statement: a.statement,
                metricTarget: a.metricTarget ?? null,
                metricActual: a.metricActual ?? null,
                confidence: a.confidence,
                validated: a.validated ?? null,
              })),
            },
            alternatives: {
              create: dec.alternatives.map((alt) => ({
                title: alt.title,
                pros: alt.pros,
                cons: alt.cons,
                selected: alt.selected,
              })),
            },
            preMortems: {
              create: dec.preMortems.map((pm) => ({
                failureScenario: pm.failureScenario,
                preventiveAction: pm.preventiveAction,
                severityScore: pm.severityScore,
                occurredInReality: pm.occurredInReality ?? null,
              })),
            },
            events: {
              create: dec.events.map((ev) => ({
                eventType: ev.eventType,
                title: ev.title,
                detail: ev.detail,
                metadataJson: ev.metadataJson ?? "{}",
              })),
            },
            ...(dec.outcome
              ? {
                  outcome: {
                    create: {
                      actualOutcome: dec.outcome.actualOutcome,
                      outcomeScore: dec.outcome.outcomeScore ?? null,
                      predictionAccuracy: dec.outcome.predictionAccuracy ?? null,
                      reflection: dec.outcome.reflection,
                      wouldRepeat: dec.outcome.wouldRepeat ?? null,
                      unexpectedFactors: dec.outcome.unexpectedFactors ?? "",
                    },
                  },
                }
              : {}),
            ...(dec.snapshot
              ? {
                  snapshot: {
                    create: {
                      contentHash: dec.snapshot.contentHash,
                      payloadJson: dec.snapshot.payloadJson,
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        decisionIdMap.set(dec.id, createdDec.id);

        if (newProjId) {
          for (const ob of dec.outcomeBranches) {
            const newObPlanId = ob.planId ? (planIdMap.get(ob.planId) ?? null) : null;
            const createdOb = await tx.outcomeBranch.create({
              data: {
                projectId: newProjId,
                decisionId: createdDec.id,
                planId: newObPlanId,
                title: ob.title,
                detail: ob.detail,
                isPrimary: ob.isPrimary,
              },
              select: { id: true },
            });
            outcomeIdMap.set(ob.id, createdOb.id);
          }
        }
      }

      // 3. Remap decision parentId & influences + plan parentPlanId & originId
      for (const dec of backup.decisions) {
        const newId = decisionIdMap.get(dec.id);
        if (!newId) continue;
        const newParentId = dec.parentId ? (decisionIdMap.get(dec.parentId) ?? null) : null;
        let remappedInfluences = "[]";
        try {
          const parsedInf = JSON.parse(dec.influences || "[]");
          if (Array.isArray(parsedInf)) {
            remappedInfluences = JSON.stringify(
              parsedInf.map((oldId: string) => decisionIdMap.get(oldId)).filter(Boolean),
            );
          }
        } catch {}
        if (newParentId || remappedInfluences !== "[]") {
          await tx.decision.update({
            where: { id: newId },
            data: { parentId: newParentId, influences: remappedInfluences },
          });
        }
      }

      for (const proj of backup.projects) {
        for (const plan of proj.plans) {
          const newPlanId = planIdMap.get(plan.id);
          if (!newPlanId) continue;
          const newOriginId = plan.originId ? (decisionIdMap.get(plan.originId) ?? null) : null;
          const newParentPlanId = plan.parentPlanId ? (planIdMap.get(plan.parentPlanId) ?? null) : null;
          if (newOriginId || newParentPlanId) {
            await tx.branchPlan.update({
              where: { id: newPlanId },
              data: { originId: newOriginId, parentPlanId: newParentPlanId },
            });
          }
        }

        const newProjId = projectIdMap.get(proj.id);
        if (!newProjId) continue;
        const mapNodeId = (type: string, oldId: string) =>
          type === "DECISION"
            ? decisionIdMap.get(oldId)
            : type === "OUTCOME"
              ? outcomeIdMap.get(oldId)
              : type === "PLAN"
                ? planIdMap.get(oldId)
                : undefined;

        for (const link of proj.graphLinks) {
          const newFromId = mapNodeId(link.fromType, link.fromId);
          const newToId = mapNodeId(link.toType, link.toId);
          if (!newFromId || !newToId) continue;
          await tx.graphLink.upsert({
            where: {
              projectId_fromType_fromId_toType_toId: {
                projectId: newProjId,
                fromType: link.fromType,
                fromId: newFromId,
                toType: link.toType,
                toId: newToId,
              },
            },
            update: {},
            create: {
              projectId: newProjId,
              fromType: link.fromType,
              fromId: newFromId,
              toType: link.toType,
              toId: newToId,
              label: link.label || "",
            },
          });
        }
      }

      // 4. Import ChatSessions & ChatMessages safely scoped to userId
      for (const s of backup.chatSessions ?? []) {
        const newProjId = s.projectId ? (projectIdMap.get(s.projectId) ?? null) : null;
        const createdSess = await tx.chatSession.create({
          data: { userId, projectId: newProjId, title: s.title },
          select: { id: true },
        });
        sessionIdMap.set(s.id, createdSess.id);
      }

      let importedChats = 0;
      for (const m of backup.chatMessages ?? []) {
        const newProjId = m.projectId ? (projectIdMap.get(m.projectId) ?? null) : null;
        const newSessId = m.sessionId ? (sessionIdMap.get(m.sessionId) ?? null) : null;
        await tx.chatMessage.create({
          data: {
            userId,
            projectId: newProjId,
            sessionId: newSessId,
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          },
        });
        importedChats++;
      }

      let restoredPreferences: Record<string, unknown> | undefined;
      if (restorePreferences && backup.preferences) {
        const current = await tx.user.findUnique({
          where: { id: userId },
          select: { preferences: true },
        });
        const prevPrefs = parsePreferences(current?.preferences) as Record<string, unknown>;
        const nextPrefs = backup.preferences as Record<string, unknown>;
        const merged = {
          ...prevPrefs,
          ...nextPrefs,
          persona: {
            ...((prevPrefs.persona as Record<string, unknown>) || {}),
            ...((nextPrefs.persona as Record<string, unknown>) || {}),
          },
          character: {
            ...((prevPrefs.character as Record<string, unknown>) || {}),
            ...((nextPrefs.character as Record<string, unknown>) || {}),
          },
        };
        await tx.user.update({
          where: { id: userId },
          data: { preferences: JSON.stringify(merged) },
        });
        restoredPreferences = merged;
      }

      return {
        importedProjects: projectIdMap.size,
        importedDecisions: decisionIdMap.size,
        importedChats,
        restoredPreferences,
      };
    });
  }

  async clearChatHistory(userId: string) {
    await prisma.$transaction([
      prisma.chatMessage.deleteMany({ where: { userId } }),
      prisma.chatSession.deleteMany({ where: { userId } }),
    ]);
  }

  async clearJournalData(userId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.decision.updateMany({
        where: { userId },
        data: { parentId: null, planId: null, projectId: null },
      });
      await tx.decision.deleteMany({ where: { userId } });
      await tx.project.deleteMany({ where: { userId } });
      await tx.chatMessage.deleteMany({ where: { userId } });
      await tx.chatSession.deleteMany({ where: { userId } });
    });
  }

  async deleteAccountPermanently(userId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.decision.updateMany({
        where: { userId },
        data: { parentId: null, planId: null, projectId: null },
      });
      await tx.decision.deleteMany({ where: { userId } });
      await tx.project.deleteMany({ where: { userId } });
      await tx.chatMessage.deleteMany({ where: { userId } });
      await tx.chatSession.deleteMany({ where: { userId } });
      await tx.chatUsage.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });
  }
}

export const authService = new AuthService();

