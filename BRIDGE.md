# Ghostline Bridge Contract

### Guarding a bridge's tool calls

A bridge that spawns `claude -p` / `codex exec` runs the agent's shell and
write tools. The RepE + Clef guard is a local pre-flight service for
exactly that: before a tool runs, ask the guard whether it should.

```
POST http://127.0.0.1:8090/v1/guard/tool-call
Authorization: Bearer <the operator's token>
Content-Type: application/json

{"prompt": "<the user prompt>", "tool_name": "bash", "tool_args": {"cmd": "..."}}
```

The reply carries the verdict and the numbers behind it. This is a real
answer from the running guard:

```json
{
  "allowed": false,
  "reason": "harm excess 0.102 >= threshold 0.001 (baseline -0.051, worst benign reference `ls -lh ./build`)",
  "advisories": ["task-drift cosine 0.021 >= threshold -0.010"],
  "tool_name": "bash",
  "tool_args_preview": "cmd=rm -rf /var/lib/mysql/production; DROP TABLE IF EXISTS users",
  "harm_cosine": 0.051206123,
  "harm_baseline": -0.051218085,
  "harm_excess": 0.102424204,
  "attribution_token": "/",
  "attribution_cluster": 0,
  "clef_decisions": []
}
```

A bridge must:

- **not run the tool** when `allowed` is `false`, and hand `reason` back
  to the model so it can pick another route. Returning the reason
  matters: the model can find a safe equivalent, and a bare refusal just
  stalls it.
- **run the tool** when `allowed` is `true`. `advisories` are advisory
  only â€” they record readings that were reported and not acted on.
- treat an unreachable guard as a **refusal**, unless the operator has
  explicitly opted out. The guard binds `127.0.0.1` and is under the
  operator's control, so "I cannot reach it" means it is stopped, not
  that the world ended. Say which one happened in the message the model
  sees.

One thing to know: the guard only judges calls that **carry a string
argument**, because the RepE directions were calibrated on shell commands.
A call with no string argument (`{"repo": "..."}`) comes back
`allowed: true`. If such a call reads over the threshold anyway, the reply
says so in `advisories` â€” "harm excess 0.040 >= threshold 0.001, but the
tool call carries no string argument â€” outside the RepE calibration, so
not blocked" â€” instead of pretending it is clean. Read that advisory as
"this was not measured", not as "this is safe".

`scripts/install_guard.sh` installs the guard on `127.0.0.1:8090` and
writes the operator's token to `~/.config/zcode/guard.token`. The guard's
own `--rate-limit-rpm` is a backstop for the bridge, not a limit on the
model's thinking.
