import type { Prisma } from "@prisma/client";

/**
 * Bridges external incoming links to external outgoing links around a set of
 * nodes being removed from a collection graph, then deletes all links
 * touching those nodes.
 */
export async function bridgeAndDeleteNodeLinks(
  tx: Prisma.TransactionClient,
  projectId: string,
  targets: { type: string; id: string }[],
) {
  if (!targets.length) return;
  const targetKeys = new Set(targets.map((t) => `${t.type}:${t.id}`));

  const orConditions = targets.flatMap((t) => [
    { fromType: t.type, fromId: t.id },
    { toType: t.type, toId: t.id },
  ]);

  const touching = await tx.graphLink.findMany({
    where: { projectId, OR: orConditions },
  });

  if (!touching.length) return;

  const incoming = touching.filter(
    (l) =>
      targetKeys.has(`${l.toType}:${l.toId}`) &&
      !targetKeys.has(`${l.fromType}:${l.fromId}`),
  );
  const outgoing = touching.filter(
    (l) =>
      targetKeys.has(`${l.fromType}:${l.fromId}`) &&
      !targetKeys.has(`${l.toType}:${l.toId}`),
  );

  for (const inc of incoming) {
    for (const out of outgoing) {
      if (inc.fromType === out.toType && inc.fromId === out.toId) continue;
      await tx.graphLink.upsert({
        where: {
          projectId_fromType_fromId_toType_toId: {
            projectId,
            fromType: inc.fromType,
            fromId: inc.fromId,
            toType: out.toType,
            toId: out.toId,
          },
        },
        update: {},
        create: {
          projectId,
          fromType: inc.fromType,
          fromId: inc.fromId,
          toType: out.toType,
          toId: out.toId,
        },
      });
    }
  }

  await tx.graphLink.deleteMany({
    where: { projectId, id: { in: touching.map((l) => l.id) } },
  });
}

