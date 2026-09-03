export function registrationEnvironmentPresentation({ environment, writeEnabled }) {
  const staging = environment === "staging";
  return {
    showStagingNotice: staging,
    showProductionClosed: environment === "production" && !writeEnabled,
  };
}
