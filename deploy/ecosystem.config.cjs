// Alternatif VPS non-systemd: pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [{ name: "althea", script: "dist/index.js", cwd: "/opt/althea", instances: 1, autorestart: true }],
};
