export const backendImage = 'ghcr.io/convex/convex-backend:4d58e45bcf49d01ec696b31db7faec7362df45ad';
const dashboardImage = 'ghcr.io/convex/convex-dashboard@sha256:284a2638e0c1a4ec0c2327d8219776f3a426ca5824b81686ae4d9454dc0ce8ed';

export function composeConfig({ name, sourceHash, secret, workerSecret, webhookSecret, adminSecret = '', tokenKey = '', adminKey = '', dashboardUrl = 'http://127.0.0.1:3210' }) {
  const runtime = {
    image: `${name}:local`, init: true, network_mode: 'service:backend',
    user: 'node', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    volumes: ['worker-state:/state'],
    environment: {
      FRED_DEV_ONLY: '1', FRED_DEV_SOURCE_HASH: sourceHash,
      CONVEX_URL: 'http://127.0.0.1:3210', CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, WORKER_SECRET: workerSecret, GITLAB_WEBHOOK_SECRET: webhookSecret, ADMIN_SECRET: adminSecret,
    },
  };
  return {
    name,
    services: {
      backend: {
        image: backendImage,
        ports: ['127.0.0.1::3210', '127.0.0.1::3211'],
        volumes: ['backend-data:/convex/data'],
        environment: { INSTANCE_NAME: name, INSTANCE_SECRET: secret, DISABLE_BEACON: 'true', DISABLE_METRICS_ENDPOINT: 'true', DO_NOT_REQUIRE_SSL: 'true' },
        healthcheck: { test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:3210/version'], interval: '1s', timeout: '5s', retries: 60 },
      },
      bootstrap: { ...runtime, environment: { ...runtime.environment, FRED_TOKEN_KEY: tokenKey }, profiles: ['setup'], command: ['node', '/app/scripts/dev/bootstrap.mjs'] },
      worker: {
        ...runtime, stop_grace_period: '2m',
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '1s', timeout: '5s', retries: 60 },
      },
      dashboard: {
        image: dashboardImage, ports: ['127.0.0.1::6791'], environment: { NEXT_PUBLIC_DEPLOYMENT_URL: dashboardUrl },
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:6791/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '2s', timeout: '5s', retries: 30 },
      },
    },
    volumes: { 'backend-data': {}, 'worker-state': {} },
  };
}
