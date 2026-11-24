import { Router } from "express";
import webPush from "web-push";
import { z } from "zod";
import { prisma } from "../config/database";
import type { AuthenticatedRequest } from "../common/guards/auth.guard";

export const reviewPushRouter = Router();
const endpoint = z.string().url().max(2048).refine(value => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && !url.port && !url.username && !url.password &&
    ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns.windows.com"]
      .some(host => url.hostname === host || url.hostname.endsWith("." + host));
});

const subscription = z.object({
  endpoint,
  keys: z.object({ p256dh: z.string().regex(/^[\w-]{87}$/), auth: z.string().regex(/^[\w-]{22}$/) }),
});

reviewPushRouter.get("/key", (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    res.status(503).json({ message: "Browser reminders are not configured." });
    return;
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

reviewPushRouter.post("/subscription", async (req: AuthenticatedRequest, res, next) => {
  const parsed = subscription.safeParse(req.body);
  if (!parsed.success || !req.userId) { res.status(400).json({ message: "Invalid browser subscription." }); return; }
  const userId = req.userId;
  const { endpoint, keys } = parsed.data;
  try {
    await prisma.$transaction(async tx => {
      const existing = await tx.reviewPushSubscription.findUnique({ where: { endpoint } });
      if (existing && existing.userId !== userId) {
        await tx.reviewPushSubscription.delete({ where: { id: existing.id } });
      }
      await tx.reviewPushSubscription.upsert({
        where: { endpoint }, create: { endpoint, userId, ...keys }, update: keys,
      });
    });
    res.sendStatus(204);
  } catch (error) { next(error); }
});

reviewPushRouter.delete("/subscription", async (req: AuthenticatedRequest, res, next) => {
  const parsed = endpoint.safeParse(req.body.endpoint);
  if (!parsed.success || !req.userId) { res.sendStatus(400); return; }
  try {
    await prisma.reviewPushSubscription.deleteMany({ where: { userId: req.userId, endpoint: parsed.data } });
    res.sendStatus(204);
  } catch (error) { next(error); }
});

export function startReviewPushWorker() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return () => {};
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:notifications@decision-replay.dev", publicKey, privateKey);
  let running = false;
  async function sendDue() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const decisions = await prisma.decision.findMany({
        where: {
          outcome: null, user: { reviewPushSubscriptions: { some: {} } },
          OR: [{ nextReminder: { lte: now } }, { nextReminder: null, reviewDate: { lte: now } }],
        },
        select: {
          id: true, nextReminder: true, reviewDate: true,
          user: { select: { reviewPushSubscriptions: true } },
          reviewPushDeliveries: { select: { subscriptionId: true, dueAt: true } },
        },
      });
      for (const decision of decisions) {
        const dueAt = decision.nextReminder ?? decision.reviewDate;
        if (!dueAt) continue;
        for (const device of decision.user?.reviewPushSubscriptions ?? []) {
          if (decision.reviewPushDeliveries.some(item =>
            item.subscriptionId === device.id && +item.dueAt === +dueAt)) continue;
          const delivery = { subscriptionId: device.id, decisionId: decision.id, dueAt };
          try {
            await prisma.reviewPushDelivery.create({ data: delivery });
          } catch (error) {
            if ((error as { code?: string }).code === "P2002") continue;
            throw error;
          }
          try {
            await webPush.sendNotification({
              endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth },
            }, JSON.stringify({ decisionId: decision.id }), { TTL: 3600, timeout: 8000 });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              await prisma.reviewPushSubscription.deleteMany({ where: { id: device.id } });
            else await prisma.reviewPushDelivery.deleteMany({ where: delivery });
          }
        }
      }
    } catch { console.error("[Review push] Could not check due reminders."); }
    finally { running = false; }
  }
  void sendDue();
  const timer = setInterval(sendDue, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
