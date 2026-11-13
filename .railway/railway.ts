import { defineRailway, project, service, volume } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "carefree-trust";
export default defineRailway(() => {
  const data = volume("carefree-trust-volume", { sizeMB: 500, region: "sfo" });
  const carefreeTrust = service("carefree-trust", {
    build: { buildEnvironment: "V3", builder: "NIXPACKS" },
    start: "npm start",
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: { "sfo": 1 },
    volumeMounts: { "/data": data },
  });

  return project("carefree-trust", {
    variables: { managed: false },
    resources: [carefreeTrust, data],
  });
});
