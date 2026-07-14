## Hive Rerun Log Analyzer

This is a Python CLI that parses Apache-style access logs and reports the following metrics:
- Total requests
- Status code counts
- Top paths
- Five slowest requests
- Malformed line count

To use the CLI, run:

```bash
python hive-rerun-log-analyzer.py <log_file>
```

For more information, see the unittests and sample log provided.