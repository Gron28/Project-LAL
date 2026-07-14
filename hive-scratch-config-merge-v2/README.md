## hive-scratch-config-merge-v2

A dependency-free CommonJS Node.js CLI that deep-merges two JSON configuration files. Objects merge recursively, arrays are replaced, null is preserved, and output can go to stdout or a named output file.

### Usage

```bash
config-merge <file1.json> <file2.json> [output.json]
```

### Examples

```bash
config-merge config1.json config2.json merged-config.json
```

### License

ISC