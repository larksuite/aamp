# aamp-feishu-bridge

Local bridge daemon for connecting a user-owned Feishu bot to a target AAMP
Agent.

## Usage

```bash
npm install
npm run build

node dist/index.js init \
  --aamp-host https://meshmail.ai \
  --target-agent agent@meshmail.ai \
  --app-id cli_xxx \
  --app-secret xxx
```

`init` writes the config and starts the local bridge immediately. Use
`--no-start` when you only want to write the config. `start` and `run` remain
available for existing configs.

If the target Agent prints a pairing URL, initialize and authorize the bridge in
one step:

```bash
node dist/index.js init \
  --pairing-url "aamp://connect?mailbox=agent@meshmail.ai&pair_code=abc123" \
  --app-id cli_xxx \
  --app-secret xxx
```

The bridge sends `pair.request` from its own AAMP mailbox with
`dispatchContextRules={ "source": ["feishu"] }`, so the Agent can accept future
Feishu dispatches without manual sender policy editing. The Agent replies with
`pair.respond` to indicate success or a failure reason.
