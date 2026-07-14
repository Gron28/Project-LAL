## hive-rerun-config-merge

A CLI tool to deep-merge two JSON config files with recursive object merging, array replacement, null preservation, and output to stdout or file.

### Usage

```bash
node index.js <file1> <file2> [outputFile]
```

### Example

Merge `config1.json` and `config2.json` and write the result to `merged-config.json`:

```bash
node index.js config1.json config2.json merged-config.json
```

### Features

- Deep-merge objects recursively
- Replace arrays
- Preserve null values
- Output to stdout or file