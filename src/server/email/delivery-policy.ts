import type { AppEnvironment } from "../env";

export type DeliveryMode = "production" | "staging_override";

export interface DeliveryAddress {
  actualEmail: string;
  deliveryMode: DeliveryMode;
}

export function resolveDeliveryAddress(
  environment: AppEnvironment,
  intendedEmail: string,
  stagingOverride?: string,
): DeliveryAddress {
  if (environment === "staging") {
    const actualEmail = stagingOverride?.trim();
    if (!actualEmail) throw new Error("staging_override_missing");
    return { actualEmail, deliveryMode: "staging_override" };
  }

  return { actualEmail: intendedEmail, deliveryMode: "production" };
}

export function resolveStaffDeliveryAddress(
  environment: AppEnvironment,
  intendedEmail: string,
  isTestStaff: boolean,
  stagingOverride?: string,
): DeliveryAddress {
  if (environment === "staging" && !isTestStaff) {
    return { actualEmail: intendedEmail, deliveryMode: "production" };
  }
  return resolveDeliveryAddress(environment, intendedEmail, stagingOverride);
}
