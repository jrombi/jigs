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

- **A copy is a version.** Every copy carries a deployment version, the string
  the World pins runs to. Hosted copies get it from `JIGS_DEPLOYMENT_VERSION`
  in their environment, the image tag the pipeline built. A laptop copy gets
  it from `jigs up`, which uses the hash of the built bundle it already
  computes. jigs sets `WORKFLOW_POSTGRES_DEPLOYMENT_ID` on the service from
  it; a factory never sets that variable itself.
- **The deploy makes a version current; booting does not.** A `deployments`
  table in the factory's database, beside the resource registry, holds every
  version that has run and which one is current. `jigs deployments current
  <version>` writes it; nothing else does. `jigs up` runs it for the copy it
  starts, since on a laptop the copy being started is the factory. A hosted
  pipeline runs it once the new version is healthy, and a rollback is running
  it with the previous version. A copy that boots and finds another version
  current does not take over: a hand-started copy cannot claim production,
  and a smoke test is just a copy that never becomes current.
- **The current version is the factory.** It polls the hub, arms the triggers
  and schedules, runs automatic release and serves the dashboard and the
  service API. Hub token requests are stateless, so every version can still
  post to GitHub, Linear and Slack for the runs it owns.
- **A version that is not current drains.** It keeps only its queue worker,
  for the runs pinned to it. It polls no hub, arms nothing, releases nothing,
  serves nothing. Whenever one of its runs is parked, with no step executing
  and no job queued, it hands that run to the current version by changing the
  run's deployment and job prefix in the World, after the same check `jigs up`
  makes: the current build must have every step and workflow ID the run
  references. A run that fails that check stays where it is until it ends. A
  parked run loses nothing by moving, and a wake for it then lands on the
  current version's task.
- **Each workflow chooses `auto-upgrade` or `pinned`.** `defineWorkflow`
  gains `versioning`, default `auto-upgrade`: the hand-over above. `pinned`
  keeps every run on the version that started it until the run ends, for
  authors who want a long agent run to finish on the code it began with. The
  words are Temporal's, so a reader who knows them knows what they mean here.
- **A drained version exits.** When nothing is pinned to it any more, it
  logs that it is retiring and exits 0. That is the whole contract jigs offers
  the platform: the container's entrypoint, a systemd unit or a person decides
  what an exit 0 after draining means. A drained copy that is asked to stop
  before then stops as today.
- **Versions are visible.** `jigs deployments` lists every version with
  whether it is current or draining, when it started, and how many runs it
  still owns, which is what Temporal calls reachability. The dashboard shows
  the same. A version with zero owned runs and no process is a row that
  `jigs deployments prune` removes.
- **Live turns reach across versions.** Two things jigs does in memory would
  otherwise break for a run on a draining version: injecting a Linear reply
  into an agent's running turn, and stopping that turn from Linear's Stop
  button. The current version receives the event and has no live turn for it.
  It writes the reply or stop to a `live_turn_messages` table in the factory's
  database and sends a Postgres `NOTIFY` on a channel keyed by the session;
  every version listens, and the one holding the live turn injects or stops
  exactly as it does today, then marks the row taken. Without the relay, Stop
  would end the session while the agent kept working. The relay also fixes the
  same gap for two laptop copies sharing a database, which today is simply
  unsupported.
- **`jigs up` keeps its shape.** It still restarts the one process a laptop
  runs, still lists executing runs and asks before cutting them off. With
  versions, a restart becomes: start the new bundle as a new version, make it
  current, and let the old one drain, which on a laptop ends within the
  longest executing step. `--force` stops the old one at once, as today.

## Consequences

- The hub is untouched. One cursor per factory, one current consumer. A
  draining version's runs are woken by the current version through the
  World, which routes to the owner.
- A Linear reply still reaches an agent mid-turn, through the relay; a reply
  to a halt reaches the listening hook as today, from the current version.
- `jigs cancel` works on any version's run: cancellation is recorded in the
  World and each agent step watches its own run
  ([0010](./0010-cancellation-stops-agents.md)).
- Changing a run's deployment is an update to the World's run row from
  outside the World's API, the way `jigs up` already reads its tables. A
  World-level "adopt run" operation would be better; this ADR does not wait
  for it.
- A `pinned` workflow, or an `auto-upgrade` run whose steps the current build
  lacks, keeps its version alive until the run ends. That is the cost of
  finishing on the code that started it, and `jigs deployments` shows who is
  paying it.
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
  again); one version living until every run it owns ends (days, for a run
  parked on a person); a central routing service such as platformatic-world
  (a control plane to run, and jigs would still need the role split this ADR
  makes); waiting for quiet before every deploy (blocks deploys behind long
  agent steps, and is what a hosted factory does until this ships).
