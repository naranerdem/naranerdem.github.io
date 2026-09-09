export function createStaffPanelState() {
  const records = new Map();

  function record(childId) {
    if (!records.has(childId)) records.set(childId, { active: "", epoch: 0 });
    return records.get(childId);
  }

  function token(childId, panel, epoch) {
    return { childId, panel, epoch };
  }

  return {
    open(childId, panel) {
      const current = record(childId);
      current.active = panel;
      current.epoch += 1;
      return token(childId, panel, current.epoch);
    },
    close(childId, panel) {
      const current = record(childId);
      if (!panel || current.active === panel) {
        current.active = "";
        current.epoch += 1;
      }
    },
    active(childId) {
      return record(childId).active;
    },
    isCurrent(value) {
      const current = record(value.childId);
      return current.active === value.panel && current.epoch === value.epoch;
    },
  };
}

export function supportedAdditionalClassPlans(target) {
  return (target?.paymentOptions ?? []).filter((plan) => plan.code === "two_installment");
}

export function selectAdditionalClassTarget(draft, targets, targetClassSessionId) {
  const target = (targets ?? []).find((item) => item.id === targetClassSessionId);
  const plans = supportedAdditionalClassPlans(target);
  return {
    ...draft,
    targetClassSessionId,
    // V1 intentionally supports only the approved two-installment lifecycle.
    paymentPlanCode: plans.length === 1 ? plans[0].code : "",
  };
}

export function selectAdditionalClassPlan(draft, target, paymentPlanCode) {
  const plans = supportedAdditionalClassPlans(target);
  return {
    ...draft,
    paymentPlanCode: plans.some((plan) => plan.code === paymentPlanCode) ? paymentPlanCode : "",
  };
}

export function createPaymentDetailSelectionState(launchRegistrationId = "") {
  let launchPending = Boolean(launchRegistrationId);
  let selectedInstallmentId = "";

  return {
    select(installmentId) {
      selectedInstallmentId = installmentId;
    },
    close(installmentId) {
      if (selectedInstallmentId === installmentId) selectedInstallmentId = "";
    },
    onRefresh(items) {
      if (launchPending) {
        launchPending = false;
        const launched = (items ?? []).find((item) => item.registrationDraftChildId === launchRegistrationId);
        if (launched?.installmentId) selectedInstallmentId = launched.installmentId;
      }
      return selectedInstallmentId;
    },
    selected() {
      return selectedInstallmentId;
    },
  };
}
