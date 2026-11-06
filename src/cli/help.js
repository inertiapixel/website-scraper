export const HELP = `Website Scraper - capture publicly accessible websites for offline reference

Usage (npm scripts):
  npm run scrape -- <url> [options]            Crawl in the foreground (Ctrl+C stops gracefully)
  npm run scrape:background -- <url> [options] Start a background job and return immediately
  npm run jobs                                 List jobs
  npm run job:status -- <JOB_ID> [--watch]     Show progress of a job
  npm run job:logs -- <JOB_ID> [--follow]      Print the job log
  npm run job:stop -- <JOB_ID> [--force]       Stop a job gracefully
  npm run job:pause -- <JOB_ID>                Pause a running job
  npm run job:resume -- <JOB_ID>               Resume a stopped/paused/interrupted/failed job
  npm run config:check                         Validate and print the effective configuration
  npm run help [-- <command>]                  Show help (e.g. npm run help -- scrape)

Direct usage:
  node bin/website-scraper.js <command> [options]
  Commands: scrape, jobs, status, logs, stop, pause, resume, config, help, version

Note: pass options after "--" when using npm scripts, e.g.
  npm run scrape -- https://example.com --max-pages 50

Defaults come from scraper.config.json. State lives in .website-scraper/
(override with WEBSITE_SCRAPER_HOME); output goes to scraped-websites/.`;

export const COMMAND_HELP = {
  scrape: `Usage: npm run scrape -- <url> [options]
       npm run scrape:background -- <url> [options]

Crawl a website starting at <url>. Only the exact hostname of <url> is crawled
unless more hosts are allowed. Each run creates a new job with its own output
directory and a snapshot of the effective configuration.

Options (override scraper.config.json for this job only):
  -b, --background              Run in a detached background worker
  -c, --config <file>           Merge a JSON configuration overlay (repeatable)
      --max-depth <n|unlimited> Maximum link depth (start page = 0)
      --max-pages <n|unlimited> Maximum number of pages to crawl
      --concurrency <n>         Pages rendered in parallel
      --delay <ms>              Minimum delay between page requests per host
      --timeout <ms>            Navigation timeout per page
      --renderer <browser|http> Render with Chromium (default) or plain HTTP
      --user-agent <string>     User-Agent header
      --include-subdomains      Also crawl subdomains of the starting host
      --allow-host <host>       Also crawl this host (repeatable; "*.example.com" allowed)
      --exclude-host <host>     Never contact this host (repeatable)
      --include-path <pattern>  Only crawl matching paths (repeatable)
      --exclude-path <pattern>  Skip matching paths (repeatable)
      --crawl-external-pages    Capture external pages linked from the site (links on them are not followed)
      --external-assets         Download assets from other hosts (CDNs)
      --no-external-assets      Only download assets from crawled hosts
      --no-assets               Save pages only
      --max-file-size <MB|unlimited>  Per-file download limit (default 1)
      --no-sitemap              Do not read sitemaps
      --ignore-robots           Do not apply robots.txt rules (only for sites you are authorized to crawl)
  -o, --output <dir>            Output base directory
      --remove-scripts          Strip <script> tags from saved pages (static snapshot)
      --no-rewrite              Save pages without rewriting links to local files
      --allow-private-network   Allow loopback/private addresses (trusted local testing only)
      --set <key.path=value>    Set any configuration value, e.g. --set crawler.settle.delayMs=2000
      --json                    (background) print machine-readable output

Path patterns: "/blog" matches /blog and everything below it; "*" matches within
one segment, "**" matches anything; "re:<regex>" uses a regular expression.`,
  jobs: `Usage: npm run jobs [-- --status <STATUS>] [--limit <n>] [--json]

List jobs, newest first. Stale workers (crashed or killed) are detected and their
jobs are marked INTERRUPTED.`,
  status: `Usage: npm run job:status -- <JOB_ID> [--watch] [--json]

Show status, progress counters, current activity, worker health, last error and
output location. --watch refreshes every 2 seconds until the job finishes.`,
  logs: `Usage: npm run job:logs -- <JOB_ID> [--follow] [--lines <n>] [--all]

Print the job's timestamped log (last 200 lines by default). --follow keeps
printing new lines until the job finishes (Ctrl+C to exit).`,
  stop: `Usage: npm run job:stop -- <JOB_ID> [--timeout <seconds>] [--no-wait] [--force]

Request a graceful stop. The worker finishes in-flight pages (up to 15s), writes
the partial offline copy and report, and exits. --force kills a worker that does
not stop within the timeout (identity is verified before any signal is sent).`,
  pause: `Usage: npm run job:pause -- <JOB_ID> [--timeout <seconds>]

Pause a running job. Progress is saved; continue with job:resume.`,
  resume: `Usage: npm run job:resume -- <JOB_ID> [--foreground] [--retry-failed]

Continue a PAUSED, STOPPED, INTERRUPTED or FAILED job from its saved queue.
Completed pages and downloaded assets are not fetched again. Runs in the
background unless --foreground is given. --retry-failed re-queues failed items.`,
  config: `Usage: npm run config:check [-- --config <file>] [scrape options]

Validate scraper.config.json (plus overlays and options) and print the result.`,
};
