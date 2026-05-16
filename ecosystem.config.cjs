// pm2 ecosystem config per docs/architecture.md §8.
//
// Single Node process per §9(a) LOCKED — `harness start` orchestrates the
// MemPalace bridge + Telegram bot + cron scheduler in one process. pm2
// supervises that single process. Don't add more apps here without
// re-opening §9.

module.exports = {
  apps: [
    {
      name: "claude-pmax-harness",
      script: "npx",
      args: "tsx src/cli/index.ts start",
      // For production after `npm run build`:
      //   script: "node",
      //   args: "dist/cli/index.js start",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      // §17.5 #6 + bridge SIGTERM grace = 5s; give pm2 10s before SIGKILL
      // so the bridge has time to flush.
      kill_timeout: 10000,
      // Paranoid backstop — Python bridge memory leaks would surface as
      // Node RSS growth and pm2 restarts the whole process.
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
      out_file: "~/.claude-pmax-harness/logs/harness.out.log",
      error_file: "~/.claude-pmax-harness/logs/harness.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
