// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Cryptographic Immutable Snapshot Engine & Hash Verification
//
// TODO: [Member A]
// 1. Maintain strict canonicalization of JSON payload (alphabetical key ordering).
// 2. Generate SHA-256 content hashes to prove decision reasoning hasn't been tampered with.
// 3. Provide `verifySnapshot` to detect hindsight modifications or database mutations.
// ==============================================================================

import crypto from "crypto";
import { prisma } from "../../config/database";

export interface SnapshotPayload {
  title: string;
  category: string;
  choice: string;
  context: string;
  decisionReason?: string;
  beliefRationale?: string;
  expectedOutcome: string;
  confidence: number;
  reviewDate?: string | null;
  assumptions: Array<{ statement: string; metricTarget?: string; confidence: number }>;
  alternatives: Array<{ title: string; pros: string; cons: string }>;
  preMortems: Array<{ failureScenario: string; preventiveAction?: string; severityScore?: number }>;
}

export class SnapshotsService {
  /**
   * Recursively sorts object keys alphabetically to guarantee deterministic JSON output.
   */
  public canonicalize(obj: unknown): string {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return "[" + obj.map((item) => this.canonicalize(item)).join(",") + "]";
    }

    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const keyValues = sortedKeys.map((key) => {
      const val = (obj as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${this.canonicalize(val)}`;
    });

    return "{" + keyValues.join(",") + "}";
  }

  /**
   * Computes SHA-256 hash of canonicalized JSON string.
   */
  public computeHash(canonicalJson: string): string {
    return crypto.createHash("sha256").update(canonicalJson).digest("hex");
  }

  /**
   * Freezes decision data into an immutable snapshot record.
   * Can be executed within an existing Prisma transaction.
   */
  public async freezeSnapshot(
    decisionId: string,
    payload: SnapshotPayload,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx?: any
  ): Promise<{ snapshotId: string; contentHash: string }> {
    const client = tx || prisma;
    const canonicalJson = this.canonicalize(payload);
    const contentHash = this.computeHash(canonicalJson);

    const snapshot = await client.snapshot.create({
      data: {
        decisionId,
        contentHash,
        payloadJson: canonicalJson,
      },
    });

    // Update parent decision record with snapshotHash and lockedAt
    await client.decision.update({
      where: { id: decisionId },
      data: {
        snapshotHash: contentHash,
        lockedAt: new Date(),
        status: "LOCKED",
      },
    });

    return { snapshotId: snapshot.id, contentHash };
  }

  /**
   * Verifies the cryptographic integrity of a locked decision.
   * Recomputes SHA-256 from payload and compares with stored hash.
   */
  public async verifySnapshot(decisionId: string): Promise<{ isVerified: boolean; contentHash: string }> {
    const snapshot = await prisma.snapshot.findUnique({
      where: { decisionId },
    });

    if (!snapshot) {
      throw new Error(`No snapshot found for decision ID: ${decisionId}`);
    }

    const recomputedHash = this.computeHash(snapshot.payloadJson);
    const isVerified = recomputedHash === snapshot.contentHash;

    if (!isVerified) {
      console.warn(`[TAMPER ALERT] Decision ${decisionId} content hash does not match stored hash!`);
    }

    return {
      isVerified,
      contentHash: snapshot.contentHash,
    };
  }
}

export const snapshotsService = new SnapshotsService();
