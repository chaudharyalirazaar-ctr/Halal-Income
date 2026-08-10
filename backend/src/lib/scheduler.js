// A lightweight in-process "run roughly once a day" scheduler — no external
// cron dependency or separate worker process, since this app doesn't have
// one. Each named job's last-run time is persisted in the DB
// (scheduler_state table), not kept in memory, specifically so a server
// restart — routine in dev, and happens on every Railway deploy in
// production — doesn't cause a job to fire again immediately just because
// in-memory state was lost. A job only actually runs once >= 24h have
// passed since its last recorded run.
const { db } = require("../db");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly tick — plenty granular for daily jobs
const STARTUP_DELAY_MS = 15 * 1000; // stay out of the critical server-boot path
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const getLastRun = db.prepare("SELECT last_run_at FROM scheduler_state WHERE job_name = ?");
const upsertLastRun = db.prepare(`
  INSERT INTO scheduler_state (job_name, last_run_at) VALUES (?, datetime('now'))
  ON CONFLICT(job_name) DO UPDATE SET last_run_at = datetime('now')
`);

const jobs = [];

function registerDailyJob(name, fn) {
  jobs.push({ name, fn });
}

function isDue(jobName) {
  const row = getLastRun.get(jobName);
  if (!row) return true;
  const last = new Date(row.last_run_at.replace(" ", "T") + "Z").getTime();
  return Date.now() - last >= ONE_DAY_MS;
}

function tick() {
  for (const { name, fn } of jobs) {
    if (!isDue(name)) continue;
    // Mark as run BEFORE the job finishes, so a slow or crashing job doesn't
    // get retried on every subsequent hourly tick — it'll simply try again
    // in ~24h like everything else, same as a job that succeeded.
    upsertLastRun.run(name);
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`[scheduler] Job "${name}" failed:`, err));
  }
}

function start() {
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { registerDailyJob, start };
