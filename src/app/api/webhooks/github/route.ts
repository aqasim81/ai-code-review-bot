import { Webhooks } from "@octokit/webhooks";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handlePullRequestEvent,
} from "@/lib/github/webhook-handler";
import { logger } from "@/lib/logger";
import type { WebhookHandlerError } from "@/types/errors";

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET });

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWebhookPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function handlerFailureResponse(
  error: WebhookHandlerError,
  context: { deliveryId: string; eventName: string },
): NextResponse {
  if (error === "INVALID_PAYLOAD") {
    logger.warn("Webhook payload rejected", context);
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }
  logger.error("Webhook handler failed", { error, ...context });
  return NextResponse.json(
    { error: "Internal processing error" },
    { status: 500 },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");

  if (!signature || !eventName || !deliveryId) {
    logger.warn("Webhook request missing required headers", {
      hasSignature: Boolean(signature),
      hasEventName: Boolean(eventName),
      hasDeliveryId: Boolean(deliveryId),
    });
    return NextResponse.json(
      { error: "Missing required webhook headers" },
      { status: 400 },
    );
  }

  const rawBody = await request.text();
  if (rawBody.length === 0) {
    logger.warn("Webhook request has an empty body", { deliveryId, eventName });
    return NextResponse.json({ error: "Empty webhook body" }, { status: 400 });
  }

  const isValid = await webhooks.verify(rawBody, signature);
  if (!isValid) {
    logger.warn("Webhook signature verification failed", {
      deliveryId,
      eventName,
    });
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  const payload = parseWebhookPayload(rawBody);
  if (payload === null) {
    logger.warn("Webhook payload is not a valid JSON object", {
      deliveryId,
      eventName,
    });
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  logger.info("Webhook received", {
    deliveryId,
    eventName,
    action: payload.action,
  });

  try {
    if (eventName === "installation" && payload.action === "created") {
      const result = await handleInstallationCreated(payload);
      if (!result.success) {
        return handlerFailureResponse(result.error, { deliveryId, eventName });
      }
      return NextResponse.json({
        received: true,
        installationId: result.data.installationId,
      });
    }

    if (eventName === "installation" && payload.action === "deleted") {
      const result = await handleInstallationDeleted(payload);
      if (!result.success) {
        return handlerFailureResponse(result.error, { deliveryId, eventName });
      }
      return NextResponse.json({
        received: true,
        acknowledged: result.data.acknowledged,
      });
    }

    if (eventName === "pull_request") {
      const result = await handlePullRequestEvent(payload);
      if (!result.success) {
        return handlerFailureResponse(result.error, { deliveryId, eventName });
      }
      return NextResponse.json({
        received: true,
        acknowledged: result.data.acknowledged,
      });
    }

    logger.debug("Unhandled webhook event", {
      eventName,
      action: payload.action,
      deliveryId,
    });
    return NextResponse.json({ received: true, handled: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Unexpected error processing webhook", {
      error: message,
      deliveryId,
      eventName,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
