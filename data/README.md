# Runtime training data

Project-LAL does not ship a default training corpus. Training data is local runtime
state: create or upload it through the Train page, or generate it with the scripts
in `../scripts/`. Do not commit generated datasets, model output, or experiment
manifests here unless a small fixture is required by an automated test.

The historical experiment summary is in
[`../docs/history/training-experiments.md`](../docs/history/training-experiments.md).
