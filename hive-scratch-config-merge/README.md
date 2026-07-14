## config-merge

A CLI tool to deep-merge two JSON configuration files. It merges objects recursively, replaces arrays, and handles null values as deliberate values. The output can be written to stdout or a named output file.

### Usage

```bash
node index.js <file1> <file2> [outputFile]
```

### Examples

Merge two JSON files and write the result to a file:
```bash
node index.js config1.json config2.json merged-config.json
```

Merge two JSON files and output to stdout:
```bash
node index.js config1.json config2.json
```

### License

MIT