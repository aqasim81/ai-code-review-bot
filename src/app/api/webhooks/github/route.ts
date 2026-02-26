import { Webhooks } from "@octokit/webhooks";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  handleInstallationCreated,
  handlePullRequestEvent,
} from "@/lib/github/webhook-handler";
import { logger } from "@/lib/logger";

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET });

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

  const payload = JSON.parse(rawBody);

  logger.info("Webhook received", {
    deliveryId,
    eventName,
    action: payload.action,
  });

  try {
    if (eventName === "installation" && payload.action === "created") {
      const result = await handleInstallationCreated(payload);
      if (!result.success) {
        logger.error("Installation handler failed", {
          error: result.error,
          deliveryId,
        });
        return NextResponse.json(
          { error: "Internal processing error" },
          { status: 500 },
        );
      }
      return NextResponse.json({
        received: true,
        installationId: result.data.installationId,
      });
    }

    if (
      eventName === "pull_request" &&
      (payload.action === "opened" || payload.action === "synchronize")
    ) {
      const result = await handlePullRequestEvent(payload);
      if (!result.success) {
        logger.error("Pull request handler failed", {
          error: result.error,
          deliveryId,
        });
        return NextResponse.json(
          { error: "Internal processing error" },
          { status: 500 },
        );
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
