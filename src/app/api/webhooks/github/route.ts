import { Webhooks } from "@octokit/webhooks";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { describeError } from "@/lib/errors";
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationRepositoriesChanged,
  handleInstallationSuspension,
  handlePullRequestEvent,
} from "@/lib/github/webhook-handler";
import { logger } from "@/lib/logger";
import type { WebhookHandlerError } from "@/types/errors";
import type { Result } from "@/types/results";

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

type EventHandler = (
  payload: Record<string, unknown>,
) => Promise<Result<Record<string, unknown>, WebhookHandlerError>>;

async function acknowledged(
  pending: Promise<Result<{ acknowledged: boolean }, WebhookHandlerError>>,
): Promise<Result<Record<string, unknown>, WebhookHandlerError>> {
  const result = await pending;
  return result.success
    ? { success: true, data: { acknowledged: result.data.acknowledged } }
    : result;
}

// Keyed by "event.action", or by event alone when every action goes to one handler.
const EVENT_HANDLERS: Readonly<Record<string, EventHandler>> = {
  "installation.created": async (payload) => {
    const result = await handleInstallationCreated(payload);
    return result.success
      ? {
          success: true,
          data: { installationId: result.data.installationId },
        }
      : result;
  },
  "installation.deleted": (payload) =>
    acknowledged(handleInstallationDeleted(payload)),
  "installation.suspend": (payload) =>
    acknowledged(handleInstallationSuspension(payload, true)),
  "installation.unsuspend": (payload) =>
    acknowledged(handleInstallationSuspension(payload, false)),
  installation_repositories: (payload) =>
    acknowledged(handleInstallationRepositoriesChanged(payload)),
  pull_request: (payload) => acknowledged(handlePullRequestEvent(payload)),
};

function findEventHandler(
  eventName: string,
  action: unknown,
): EventHandler | undefined {
  return typeof action === "string"
    ? (EVENT_HANDLERS[`${eventName}.${action}`] ?? EVENT_HANDLERS[eventName])
    : EVENT_HANDLERS[eventName];
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
    const handler = findEventHandler(eventName, payload.action);
    if (!handler) {
      logger.debug("Unhandled webhook event", {
        eventName,
        action: payload.action,
        deliveryId,
      });
      return NextResponse.json({ received: true, handled: false });
    }

    const result = await handler(payload);
    if (!result.success) {
      return handlerFailureResponse(result.error, { deliveryId, eventName });
    }
    return NextResponse.json({ received: true, ...result.data });
  } catch (error) {
    const message = describeError(error, "Unknown error");
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
