# Completion discipline

An agent/process exit, a token-limit stop, a build completion, or an observed
error is never a terminal condition by itself. When a user has requested an
end-to-end outcome, immediately take the next required action: inspect the
result, run the relevant acceptance check, diagnose/fix failure, and continue
until the outcome is verified or genuinely blocked. Report status only after
that next concrete action; do not leave a known next step for the user to ask
for.
