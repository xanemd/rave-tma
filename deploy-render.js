/**
 * Автоматический деплой Rave TMA на Render.com через API.
 * Структура payload — точно по документации Render:
 * https://api-docs.render.com/reference/create-service
 */
const API_KEY = "rnd_R66EZjUPO072LyuvFzdybXNHAChP";
const OWNER_ID = "tea-d9o9v37lk1mc7385d38g";

const payload = {
  type: "web_service",
  name: "rave-tma",
  ownerId: OWNER_ID,
  repo: "https://github.com/xanemd/rave-tma",
  branch: "main",
  autoDeploy: "yes",
  plan: "free",
  numInstances: 1,
  envVars: [],
  serviceDetails: {
    env: "node",
    buildCommand: "npm install",
    startCommand: "npm start",
    healthCheckPath: "/",
    envSpecificDetails: {
      buildCommand: "npm install",
      startCommand: "npm start",
      healthCheckPath: "/",
      runtime: "node",
      numInstances: 1,
      pullRequestPreviewsEnabled: false,
    },
  },
};

async function main() {
  const res = await fetch("https://api.render.com/v1/services", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log("STATUS:", res.status);
  console.log(body);

  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});