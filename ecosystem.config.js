// HyperFlow PM2 ecosystem for the root TypeScript project.
//
// Start:   pm2 start ecosystem.config.js
// Logs:    pm2 logs hyperflow
// Restart: pm2 restart hyperflow
// Stop:    pm2 stop hyperflow

const PROJECT_ROOT = __dirname;
const LOG_DIR = `${PROJECT_ROOT}/logs`;

module.exports = {
  apps: [
    {
      name: "hyperflow",
      cwd: PROJECT_ROOT,
      script: "npm",
      args: "run start",
      out_file: `${LOG_DIR}/hyperflow.out.log`,
      error_file: `${LOG_DIR}/hyperflow.err.log`,
      merge_logs: true,
      time: true,
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
      restart_delay: 10000,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
