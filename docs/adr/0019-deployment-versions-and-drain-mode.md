# A factory runs as versions, and a version drains before it exits

Status: proposed

A factory is one process per copy ([0018](./0018-environment-configures-each-copy.md)).
Restarting it cuts off every step that is executing: the step runs again from
its start, and an agent is re-prompted in a worktree it may have half changed.
`jigs up` asks before doing that. A hosted factory has no one to ask: a deploy
starts a new task and stops the old one, and anything the old one was doing is
cut off. Teams that run a factory on a server deploy several times a day, so
this is the normal case, not the exception.

`@workflow/world-postgres` 5.3 added `WORKFLOW_POSTGRES_DEPLOYMENT_ID`. Each
deployment gets its own queue task, a worker claims only its own deployment's
jobs, and a message for another deployment's run is put on that deployment's
task. So two copies on one database can share the work: the new one takes new
runs, the old one finishes the runs it started. What the World does not say is
which copy is *the* factory, when the old copy may stop, and how the things
jigs keeps in one process reach a run that lives in the other. This ADR says
that. The vocabulary follows Temporal's worker deployment versioning, which
solves the same problem for the same reasons; where jigs differs, it says so.

- **A hosted copy is a version.** A copy that deploys beside another carries a
  deployment version from `JIGS_DEPLOYMENT_VERSION` in its environment, the
  image tag the pipeline built. jigs sets `WORKFLOW_POSTGRES_DEPLOYMENT_ID` on
  the service from it, and refuses to start when that variable is already set
  to something else. The variable is optional: a copy without it, such as the
  one `jigs up` runs on a laptop, is the factory's only copy, behaves as before
  this ADR and takes no part in roles or draining.
- **The deploy makes a version current; booting does not.** A `deployments`
  table in the factory's database, beside the resource registry, holds every
  version that has run, which one is current, and when each stopped being
  current. `jigs deployments current <version>` writes it; nothing else does.
  A hosted pipeline runs it once the new version is healthy, and a rollback is
  running it with the previous version. A copy that boots and finds another
  version current does not take over: a hand-started copy cannot claim
  production, and a smoke test is just a copy that never becomes current.
- **The current version is the factory.** It polls the hub, arms the triggers
  and schedules, runs automatic release and serves the dashboard and the
  service API. New runs start there. Hub token requests are stateless, so
  every version can still post to GitHub, Linear and Slack for its own runs.
- **A run finishes on the version that started it.** There is no hand-over
  between versions and no per-workflow choice. `@workflow/core` seeds a run's
  replay with `${runId}:${workflowName}:${deploymentId}`, so a run's
  deterministic values (step correlation IDs, `Math.random`, ULIDs) depend on
  the deployment it started on; and with a deployment ID set, the World enforces
  deployment affinity, so only that deployment's worker executes the run. A run
  moved to another version would replay differently, and moving it would mean
  writing the World's and Graphile Worker's private tables from outside. A wake
  for a run, such as a hook resumed from another copy, is routed by the World
  to the run's own deployment.
- **A version that is not current drains.** It keeps only its queue worker. It
  polls no hub, arms nothing, releases nothing, serves nothing. Once it has no
  live run and nothing queued on its task, it logs that it drained and exits 0.
  That is the whole contract jigs offers the platform: an exit 0 after draining
  is the end of that task, so the platform restarts a copy only on failure. A
  version that was never current never exits on its own.
- **Draining is capped.** A version that has not been current for
  `deployments.maxDrainDays` days (default 14), counted from when another
  version was made current, cancels its remaining live runs through the same
  cancellation `jigs cancel` uses, logs each, and exits 0. A run parked on a
  person cannot keep a build alive indefinitely, and the cancel is visible in
  the run's history like any other.
- **A crashed version keeps its runs.** Nothing adopts them: they wait until
  that version restarts, which is why the platform must restart it on failure.
  `jigs deployments prune` refuses to forget a version with no process that
  still has live runs, unless `--cancel-runs` cancels them first.
- **Versions are visible.** `jigs deployments` lists every version with
  whether it is current, draining or gone, when it started, and how many live
  runs it started, which is what Temporal calls reachability.
- **Live turns reach across versions.** Two things jigs does in memory would
  otherwise break for a run on a draining version: injecting a Linear reply
  into an agent's running turn, and stopping that turn from Linear's Stop
  button. The current version receives the event and has no live turn for it.
  It writes the reply or stop to a `live_turn_messages` table in the factory's
  database and sends a Postgres `NOTIFY` on a channel keyed by the session;
  every version listens, and the one holding the live turn injects or stops
  exactly as it does today, then marks the row taken. Without the relay, Stop
  would end the session while the agent kept working. Only versioned copies
  run the relay.
- **`jigs up` is unchanged.** It restarts the one unversioned process a
  laptop runs, lists executing runs and asks before cutting them off, and
  refuses a build that lacks a workflow or step a live run needs.

## Consequences

- The hub is untouched. One cursor per factory, one current consumer. A
  draining version's runs are woken by the current version through the
  World, which routes to the run's deployment.
- A Linear reply still reaches an agent mid-turn, through the relay; a reply
  to a halt reaches the listening hook as today, from the current version.
- `jigs cancel` works on any version's run: cancellation is recorded in the
  World and each agent step watches its own run
  ([0010](./0010-cancellation-stops-agents.md)).
- jigs writes nothing into the World's or Graphile Worker's tables; it only
  reads them, to count a version's live runs and queued jobs.
- A run parked on a person keeps its version alive until it ends or the cap
  cancels it. That is the cost of finishing on the code that started it, and
  `jigs deployments` shows who is paying it.
- A crashed version that is not restarted strands its runs until someone
  starts it or prunes it with `--cancel-runs`.
- Moving a factory from an unversioned copy to versioned ones leaves the
  unversioned copy's live runs to an unversioned copy: let them finish first.
- The deploy that introduces this needs `@workflow/world-postgres` 5.3 and
  its migrations, 0027 (timestamps with time zone) in particular.
- Not taken from Temporal: signals, because a Temporal signal reaches the
  workflow and not the running activity while jigs's live-turn injection
  reaches the agent mid-turn and the relay keeps that; a central run-state
  server, because [0015](./0015-hub.md) keeps run state in each factory; and
  ramped rollouts, because a factory deploys a few times a day for a handful
  of operators.
- Rejected: the newest copy marking itself current on boot (a hand-started
  copy would take production, and rollback would mean starting the old copy
  again); handing parked runs to the current version, per workflow or always
  (the replay seed includes the deployment, so a moved run replays
  differently, and the move writes the World's private tables); adopting a
  crashed version's runs (the same move); one version living until every run
  it started ends, with no cap (months, for a run parked on a person who
  left); a central routing service such as platformatic-world
  (a control plane to run, and jigs would still need the role split this ADR
  makes); waiting for quiet before every deploy (blocks deploys behind long
  agent steps, and is what a hosted factory does until this ships).
